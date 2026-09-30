// ported from pi-autoresearch@939ede8 index.ts:1702-2073 (run_experiment's execute).
//
// pi spawned `bash -c <command>` detached in-process; here libexec/run-experiment.sh
// does it under $.process.spawn and supplies the process group, the timeout (TERM, then
// KILL 5 s later: I4) and a tee of every byte to the temp log. The rolling buffer, the
// 1 s partial updates, the checks run and the text for the model are upstream's.
// Upstream spilled to `pi-experiment-<hex>.log` once output passed 50 KiB and wrote the
// same file afterwards for output over 4 KiB or 10 lines; the tee'd log is that file,
// named `autoresearch-experiment-<hex>.log`, and removed when upstream would not have
// made it.

import { posix as path } from "../../upstream/vendor/path.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateTail } from "../../upstream/vendor/truncate.ts";
import {
  EXPERIMENT_MAX_BYTES,
  EXPERIMENT_MAX_LINES,
  blockedRunDetails,
  currentResults,
  formatElapsed,
  isAutoresearchShCommand,
  maxExperimentsReachedText,
  measureScriptRequiredText,
  parseMetricLines,
  runResultText,
  validateWorkDir,
  workDirErrorText,
  type RunDetails,
} from "../../upstream/experiment-core.ts";
import type { Host } from "../host.ts";
import { publish, resolveWorkDir, sessionFilesOf, type Ctx } from "../context.ts";
import { updateWidget } from "../activation.ts";
import type { ToolAnswer } from "./answer.ts";

export interface RunParams {
  command: string;
  timeout_seconds?: number;
  checks_timeout_seconds?: number;
}

/** Lines of the running output a row keeps (the collapsed preview shows 5). */
const ROW_TAIL_LINES = 20;
/** The checks output kept for the gate and the model (upstream kept it whole, then cut). */
const CHECKS_KEEP_BYTES = 512 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8");

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function wrapperArgv(host: Host, timeoutSeconds: number, marker: string, log: string, command: string, stderrFile?: string): string[] {
  return [
    "bash",
    `${host.pluginRoot}/libexec/run-experiment.sh`,
    ...(stderrFile ? ["--stderr-file", stderrFile] : []),
    String(timeoutSeconds),
    marker,
    log,
    "--",
    command,
  ];
}

async function removeQuietly(host: Host, filePath: string): Promise<void> {
  await host.remove(filePath).catch(() => undefined);
}

export async function executeRun(
  ctx: Ctx,
  params: RunParams,
  toolUseId: string,
  signal?: AbortSignal,
): Promise<ToolAnswer> {
  const host = ctx.host;
  const runtime = ctx.runtime;
  const state = runtime.state;
  const cwd = await host.sessionCwd();

  // Validate working directory exists
  const workDir = await resolveWorkDir(host, cwd);
  const workDirError = validateWorkDir(cwd, workDir, await host.kind(workDir));
  if (workDirError) {
    return { result: workDirErrorText(workDirError) };
  }

  // Block if max experiments limit already reached
  if (state.maxExperiments !== null) {
    const segCount = currentResults(state.results, state.currentSegment).length;
    if (segCount >= state.maxExperiments) {
      return { result: maxExperimentsReachedText(state.maxExperiments) };
    }
  }

  const timeout = (params.timeout_seconds ?? 600) * 1000;

  // Guard: if the benchmark script exists, only allow running it
  const files = await sessionFilesOf(host, workDir);
  const autoresearchShPath = files.path("measure");
  const benchmarkScriptRel = path.relative(workDir, autoresearchShPath) || path.basename(autoresearchShPath);
  if (files.exists(autoresearchShPath) && !isAutoresearchShCommand(params.command)) {
    return {
      result: measureScriptRequiredText(benchmarkScriptRel, autoresearchShPath, params.command),
      details: { tool: "run_experiment", details: blockedRunDetails(params.command) },
    };
  }

  runtime.runningExperiment = { startedAt: Date.now(), command: params.command, toolUseId };
  updateWidget(ctx);

  const t0 = Date.now();
  const tmp = await host.tmpDir();
  const stem = path.join(tmp, `autoresearch-experiment-${randomHex(8)}`);
  const fullLogPath = `${stem}.log`;
  const timeoutMarker = `${stem}.timeout`;

  // Rolling buffer for tail truncation (keep 2x what we need)
  const chunks: Uint8Array[] = [];
  let chunksBytes = 0;
  const maxChunksBytes = DEFAULT_MAX_BYTES * 2;

  // Temp file for full output when it overflows
  let tempFilePath: string | undefined;
  let totalBytes = 0;

  // Cache for the decoded buffer — only rebuild when chunks change
  let chunksGeneration = 0;
  let cachedGeneration = -1;
  let cachedText = "";

  function getBufferText(): string {
    if (cachedGeneration === chunksGeneration) return cachedText;
    cachedText = decoder.decode(concatBytes(chunks));
    cachedGeneration = chunksGeneration;
    return cachedText;
  }

  // Timer interval — update every second with elapsed time + tail output
  const timerInterval = host.every(1000, () => {
    const elapsed = formatElapsed(Date.now() - t0);
    const trunc = truncateTail(getBufferText(), {
      maxLines: DEFAULT_MAX_LINES,
      maxBytes: DEFAULT_MAX_BYTES,
    });
    host.publish({
      runTail: { toolUseId, elapsed, tail: (trunc.content || "").split("\n").slice(-ROW_TAIL_LINES).join("\n") },
    });
  });

  const handleData = (data: Uint8Array) => {
    totalBytes += data.length;

    // Start keeping the full log once we exceed the threshold
    if (totalBytes > DEFAULT_MAX_BYTES && !tempFilePath) {
      tempFilePath = fullLogPath;
    }

    // Keep rolling buffer of recent data
    chunks.push(data);
    chunksBytes += data.length;

    // Evict old chunks, then trim the first surviving chunk to a line
    // boundary. This avoids splitting multi-byte UTF-8 characters that
    // straddle chunk boundaries (which would produce U+FFFD on decode).
    while (chunksBytes > maxChunksBytes && chunks.length > 1) {
      const removed = chunks.shift()!;
      chunksBytes -= removed.length;
    }
    // Trim first surviving chunk to a newline boundary
    if (chunks.length > 0 && chunksBytes > maxChunksBytes) {
      const buf = chunks[0];
      const nlIdx = buf.indexOf(0x0a); // '\n'
      if (nlIdx !== -1 && nlIdx < buf.length - 1) {
        chunks[0] = buf.subarray(nlIdx + 1);
        chunksBytes -= nlIdx + 1;
      }
    }

    chunksGeneration++;
  };

  let exitCode: number | null;
  let timedOut: boolean;
  try {
    const child = host.spawn(wrapperArgv(host, timeout / 1000, timeoutMarker, fullLogPath, params.command), {
      cwd: workDir,
      signal,
    });
    for await (const { text } of child) {
      handleData(encoder.encode(text));
    }
    const ended = await child.result;
    if (signal?.aborted) throw new Error("aborted");
    exitCode = ended.code;
    timedOut = await host.exists(timeoutMarker);
  } catch (error) {
    timerInterval.cancel();
    await removeQuietly(host, fullLogPath);
    await removeQuietly(host, timeoutMarker);
    throw signal?.aborted ? new Error("aborted") : error;
  } finally {
    timerInterval.cancel();
    runtime.runningExperiment = null;
    updateWidget(ctx);
    host.publish({ runTail: null });
  }
  await removeQuietly(host, timeoutMarker);

  const durationSeconds = (Date.now() - t0) / 1000;
  runtime.lastRunDuration = durationSeconds;
  const benchmarkPassed = exitCode === 0 && !timedOut;

  // Run backpressure checks if benchmark passed and checks file exists
  let checksPass: boolean | null = null;
  let checksTimedOut = false;
  let checksOutput = "";
  let checksDuration = 0;

  const checksPath = (await sessionFilesOf(host, workDir)).path("checks");
  if (benchmarkPassed && (await host.exists(checksPath))) {
    const checksTimeout = (params.checks_timeout_seconds ?? 300) * 1000;
    const ct0 = Date.now();
    try {
      const checksResult = await runChecks(host, checksPath, workDir, checksTimeout, tmp, signal);
      checksDuration = (Date.now() - ct0) / 1000;
      checksTimedOut = checksResult.killed;
      checksPass = checksResult.code === 0 && !checksResult.killed;
      checksOutput = (checksResult.stdout + "\n" + checksResult.stderr).trim();
    } catch (e) {
      if (signal?.aborted) {
        await removeQuietly(host, fullLogPath);
        throw new Error("aborted");
      }
      checksDuration = (Date.now() - ct0) / 1000;
      checksPass = false;
      checksOutput = e instanceof Error ? e.message : String(e);
    }
  }

  // Store checks result for log_experiment gate
  runtime.lastRunChecks = checksPass !== null ? { pass: checksPass, output: checksOutput, duration: checksDuration } : null;
  publish(ctx, ["loop"]);

  const passed = benchmarkPassed && (checksPass === null || checksPass);

  // Reuse the full log if output overflowed, otherwise keep it for large output
  const output = getBufferText();
  let fullOutputPath: string | undefined = tempFilePath;
  const totalLines = output.split("\n").length;
  if (!fullOutputPath && (totalBytes > EXPERIMENT_MAX_BYTES || totalLines > EXPERIMENT_MAX_LINES)) {
    fullOutputPath = fullLogPath;
  }
  if (!fullOutputPath) await removeQuietly(host, fullLogPath);

  // Wider truncation for TUI display (details.tailOutput)
  const displayTruncation = truncateTail(output, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });

  // Tight truncation for LLM context (10 lines / 4KB)
  const llmTruncation = truncateTail(output, {
    maxLines: EXPERIMENT_MAX_LINES,
    maxBytes: EXPERIMENT_MAX_BYTES,
  });

  // Parse structured METRIC lines from output
  const parsedMetricMap = parseMetricLines(output);
  const parsedMetrics = parsedMetricMap.size > 0
    ? Object.fromEntries(parsedMetricMap)
    : null;
  const parsedPrimary = parsedMetricMap.get(state.metricName) ?? null;

  const details: RunDetails = {
    command: params.command,
    exitCode,
    durationSeconds,
    passed,
    crashed: !passed,
    timedOut,
    tailOutput: displayTruncation.content,
    checksPass,
    checksTimedOut,
    checksOutput: checksOutput.split("\n").slice(-80).join("\n"),
    checksDuration,
    parsedMetrics,
    parsedPrimary,
    metricName: state.metricName,
    metricUnit: state.metricUnit,
  };

  const text = runResultText(state, details, benchmarkPassed, llmTruncation, fullOutputPath);

  return {
    result: text,
    details: {
      tool: "run_experiment",
      details: {
        ...details,
        truncation: llmTruncation.truncated
          ? {
              truncated: true,
              truncatedBy: llmTruncation.truncatedBy,
              outputLines: llmTruncation.outputLines,
              totalLines: llmTruncation.totalLines,
            }
          : undefined,
        fullOutputPath,
      },
    },
  };
}

/**
 * pi.exec("bash", [checksPath], { signal, timeout, cwd }) through the wrapper, whose
 * timeout has no ten-minute cap: stdout and stderr apart, `killed` for a timeout.
 */
async function runChecks(
  host: Host,
  checksPath: string,
  workDir: string,
  timeoutMs: number,
  tmp: string,
  signal?: AbortSignal,
): Promise<{ code: number | null; stdout: string; stderr: string; killed: boolean }> {
  const stem = path.join(tmp, `autoresearch-checks-${randomHex(8)}`);
  const log = `${stem}.log`;
  const marker = `${stem}.timeout`;
  const stderrFile = `${stem}.stderr`;
  try {
    let stdout = "";
    const child = host.spawn(
      wrapperArgv(host, timeoutMs / 1000, marker, log, `bash ${shellQuote(checksPath)}`, stderrFile),
      { cwd: workDir, signal },
    );
    for await (const { text } of child) {
      stdout += text;
      if (stdout.length > CHECKS_KEEP_BYTES * 2) stdout = stdout.slice(-CHECKS_KEEP_BYTES);
    }
    const ended = await child.result;
    if (signal?.aborted) throw new Error("aborted");
    const killed = await host.exists(marker);
    const stderr = (await host.run(["tail", "-c", String(CHECKS_KEEP_BYTES), stderrFile], { cwd: workDir })).stdout;
    return { code: ended.code, stdout, stderr, killed };
  } finally {
    await removeQuietly(host, log);
    await removeQuietly(host, marker);
    await removeQuietly(host, stderrFile);
  }
}
