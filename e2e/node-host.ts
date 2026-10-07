// The Host on Node, for the engine-less end-to-end suite (PLAN §7.2): the same app code
// register.tsx runs, over the real file system, real bash, git and the real wrapper,
// with everything the engine would show or send recorded for the scenarios to assert on.
// It mirrors the engine's contracts where the app relies on them: `run` rejects on its
// timeout and reads a signal death as exit 1, `spawn` never splits a multibyte character
// and kills its child when the loop is left, writes create their folders, and git runs
// with the repository's hooks off (F11).

import { spawn as spawnChild } from "node:child_process";
import { constants, promises as fsp } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

import type {
  Cancel,
  FileKind,
  Host,
  LoopState,
  NoticeLevel,
  ProcessResult,
  RateLimit,
  SpawnChunk,
  SpawnEnd,
  Spawned,
  ToolDetails,
  ToolSpec,
  View,
} from "../plugin/hooks/app/host.ts";
import {
  createApp,
  type App,
  type CompactMessage,
  type Options,
  type ToolAnswer,
  type ToolName,
} from "../plugin/hooks/app/index.ts";

export const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const PLUGIN_ROOT = nodePath.join(REPO_ROOT, "plugin");
/** Claude Code refuses a `$.state` value over this many characters of JSON (2.1.285, still on 2.1.292). */
const STATE_LIMIT_CHARS = 4 * 1024 * 1024;

/** What the engine does to every process it runs for a plugin: repo git hooks off (F11). */
const HOOKS_OFF = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "/dev/null" };

export interface NodeHostOptions {
  cwd: string;
  sessionId?: string;
  terminal?: boolean;
  /** Multiplies every `after`/`every` delay: the resume window in tests is short. */
  timeScale?: number;
  contextPercent?: number | null;
  /** The store the engine keeps per plugin; share one to model a restart. */
  store?: Map<string, unknown>;
  /** The state the engine keeps across a hot reload; share one to model a reload. */
  loop?: { value?: LoopState };
  /** The usage-limit windows `$.session.usage()` reports. */
  rateLimits?: RateLimit[];
  /** Someone can be asked (a surface draws the session); `-p` by default. */
  canAsk?: boolean;
}

export class NodeHost implements Host {
  readonly pluginRoot = PLUGIN_ROOT;
  cwd: string;
  sessionIdValue: string;
  terminal: boolean;
  timeScale: number;
  contextPercentValue: number | null;
  store: Map<string, unknown>;
  loop: { value?: LoopState };
  rateLimitsValue: RateLimit[];
  canAskValue: boolean;

  notices: { text: string; level: NoticeLevel }[] = [];
  /** Lines written to the transcript. */
  logs: string[] = [];
  /** Every status line set, null for a removal; the last is what shows. */
  statuses: (string | null)[] = [];
  /** The questions asked, and the answers to give them in order (null: dismissed). */
  questions: { question: string; options: readonly string[]; header?: string }[] = [];
  answers: (string | null)[] = [];
  submitted: string[] = [];
  aborted: string[] = [];
  registered: ToolSpec[] = [];
  invalidated: string[] = [];
  dashboardCloses = 0;
  compactions = 0;
  /** The engine running our session.compact hook for the `/compact` the app runs; null
   * models a compaction refused before it reaches us. */
  compactHook: (() => Promise<void>) | null = null;
  posts: { url: string; body: string }[] = [];
  openedUrls: string[] = [];
  view: Partial<View> = {};
  /** Views the engine would have refused as over its 4 MiB limit. */
  refusedViews: (keyof View)[] = [];
  toolDetails = new Map<string, ToolDetails>();
  runs: string[][] = [];

  private timers = new Set<ReturnType<typeof setTimeout>>();
  private children = new Set<ReturnType<typeof spawnChild>>();
  private listeners = new Set<() => void>();

  constructor(options: NodeHostOptions) {
    this.cwd = options.cwd;
    this.sessionIdValue = options.sessionId ?? "session-1";
    this.terminal = options.terminal ?? true;
    this.timeScale = options.timeScale ?? 1;
    this.contextPercentValue = options.contextPercent ?? null;
    this.store = options.store ?? new Map();
    this.loop = options.loop ?? {};
    this.rateLimitsValue = options.rateLimits ?? [];
    this.canAskValue = options.canAsk ?? false;
  }

  /** The status line showing now. */
  get status(): string | null {
    return this.statuses.at(-1) ?? null;
  }

  // -- test helpers -------------------------------------------------------------

  /** Resolves once `predicate` holds, checked on every recorded change and every 20 ms. */
  waitFor(predicate: () => boolean, timeoutMs = 10_000, what = "condition"): Promise<void> {
    if (predicate()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const check = () => {
        if (!predicate()) return;
        cleanup();
        resolve();
      };
      const poll = setInterval(check, 20);
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`timed out waiting for ${what}`));
      }, timeoutMs);
      const cleanup = () => {
        clearInterval(poll);
        clearTimeout(timeout);
        this.listeners.delete(check);
      };
      this.listeners.add(check);
    });
  }

  private changed(): void {
    for (const listener of [...this.listeners]) listener();
  }

  /** Cancels timers and kills children still running (the session is over). */
  dispose(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const child of this.children) child.kill("SIGKILL");
    this.children.clear();
  }

  // -- session --------------------------------------------------------------------

  async sessionCwd(): Promise<string> {
    return this.cwd;
  }
  async sessionId(): Promise<string> {
    return this.sessionIdValue;
  }
  async hasTerminal(): Promise<boolean> {
    return this.terminal;
  }
  async tmpDir(): Promise<string> {
    return tmpdir().replace(/\/+$/, "") || "/tmp";
  }
  async parentPid(): Promise<string | undefined> {
    return String(process.pid);
  }
  async contextPercent(): Promise<number | null> {
    return this.contextPercentValue;
  }
  async rateLimits(): Promise<RateLimit[]> {
    return structuredClone(this.rateLimitsValue);
  }
  async compact(): Promise<void> {
    this.compactions++;
    await this.compactHook?.();
    this.changed();
  }

  // -- files ----------------------------------------------------------------------

  async readText(path: string): Promise<string | null> {
    try {
      return await fsp.readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  async writeText(path: string, text: string): Promise<void> {
    await fsp.mkdir(nodePath.dirname(path), { recursive: true });
    await fsp.writeFile(path, text);
  }
  async appendText(path: string, text: string): Promise<void> {
    await fsp.mkdir(nodePath.dirname(path), { recursive: true });
    await fsp.appendFile(path, text);
  }
  async exists(path: string): Promise<boolean> {
    try {
      await fsp.stat(path);
      return true;
    } catch {
      return false;
    }
  }
  async kind(path: string): Promise<FileKind | null> {
    try {
      const stat = await fsp.stat(path);
      return stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other";
    } catch {
      return null;
    }
  }
  async realPath(path: string): Promise<string | null> {
    try {
      return await fsp.realpath(path);
    } catch {
      return null;
    }
  }
  async isExecutable(path: string): Promise<boolean> {
    try {
      await fsp.access(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  async remove(path: string): Promise<void> {
    await fsp.rm(path, { force: true });
  }

  // -- processes --------------------------------------------------------------------

  run(argv: readonly string[], init: { cwd: string; stdin?: string; timeoutMs?: number }): Promise<ProcessResult> {
    this.runs.push([...argv]);
    return new Promise((resolve, reject) => {
      const child = spawnChild(argv[0]!, argv.slice(1), {
        cwd: init.cwd,
        env: { ...process.env, ...HOOKS_OFF },
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.children.add(child);
      const out = new StringDecoder("utf8");
      const err = new StringDecoder("utf8");
      let stdout = "";
      let stderr = "";
      let settled = false;
      child.stdout!.on("data", (chunk: Buffer) => (stdout += out.write(chunk)));
      child.stderr!.on("data", (chunk: Buffer) => (stderr += err.write(chunk)));
      child.stdin!.on("error", () => undefined);
      child.stdin!.end(init.stdin ?? "");
      const timer = init.timeoutMs
        ? setTimeout(() => {
            if (settled) return;
            settled = true;
            child.kill("SIGKILL");
            this.children.delete(child);
            reject(new Error(`${argv[0]} timed out after ${init.timeoutMs} ms`));
          }, init.timeoutMs)
        : undefined;
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.children.delete(child);
        reject(error);
      });
      child.on("close", (code) => {
        this.children.delete(child);
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ exitCode: code ?? 1, stdout: stdout + out.end(), stderr: stderr + err.end() });
      });
    });
  }

  spawn(argv: readonly string[], init: { cwd: string; env?: Record<string, string>; signal?: AbortSignal }): Spawned {
    this.runs.push([...argv]);
    const child = spawnChild(argv[0]!, argv.slice(1), {
      cwd: init.cwd,
      env: { ...process.env, ...HOOKS_OFF, ...init.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.children.add(child);
    const queue: SpawnChunk[] = [];
    let ended = false;
    let failure: Error | null = null;
    let wake: (() => void) | null = null;
    const notify = () => {
      const resume = wake;
      wake = null;
      resume?.();
    };
    const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
    const push = (stream: "stdout" | "stderr", text: string) => {
      if (!text) return;
      queue.push({ stream, text });
      notify();
    };
    child.stdout!.on("data", (chunk: Buffer) => push("stdout", decoders.stdout.write(chunk)));
    child.stderr!.on("data", (chunk: Buffer) => push("stderr", decoders.stderr.write(chunk)));

    const result = new Promise<SpawnEnd>((resolve, reject) => {
      child.on("error", (error) => {
        failure = error;
        ended = true;
        this.children.delete(child);
        notify();
        reject(error);
      });
      child.on("close", (code, signal) => {
        push("stdout", decoders.stdout.end());
        push("stderr", decoders.stderr.end());
        ended = true;
        this.children.delete(child);
        notify();
        resolve({ code, signal });
      });
    });
    result.catch(() => undefined);

    const kill = () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    };
    if (init.signal?.aborted) kill();
    else init.signal?.addEventListener("abort", kill, { once: true });

    const iterator: AsyncIterator<SpawnChunk> = {
      async next() {
        for (;;) {
          if (queue.length > 0) return { value: queue.shift()!, done: false };
          if (failure) throw failure;
          if (ended) return { value: undefined, done: true };
          await new Promise<void>((resolve) => (wake = resolve));
        }
      },
      async return() {
        kill();
        return { value: undefined, done: true };
      },
    };
    return { result, [Symbol.asyncIterator]: () => iterator };
  }

  // -- time -------------------------------------------------------------------------

  after(ms: number, fn: () => void): Cancel {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, ms * this.timeScale);
    this.timers.add(timer);
    return { cancel: () => (clearTimeout(timer), this.timers.delete(timer)) };
  }
  every(ms: number, fn: () => void): Cancel {
    const timer = setInterval(fn, ms * this.timeScale);
    return { cancel: () => clearInterval(timer) };
  }

  // -- the person, the model --------------------------------------------------------

  notify(text: string, level: NoticeLevel): void {
    this.notices.push({ text, level });
    this.changed();
  }
  log(text: string): void {
    this.logs.push(text);
    this.changed();
  }
  setStatus(text: string | null): void {
    this.statuses.push(text);
    this.changed();
  }
  async canAsk(): Promise<boolean> {
    return this.canAskValue;
  }
  async ask(question: string, options: readonly string[], header?: string): Promise<string | null> {
    this.questions.push({ question, options: [...options], ...(header ? { header } : {}) });
    this.changed();
    return this.answers.shift() ?? null;
  }
  closeDashboard(): void {
    this.dashboardCloses++;
  }
  submit(text: string): void {
    this.submitted.push(text);
    this.changed();
  }
  async abortTurn(turnId: string): Promise<void> {
    this.aborted.push(turnId);
    this.changed();
  }
  async registerTool(spec: ToolSpec): Promise<string> {
    this.registered.push(spec);
    return `mcp__autoresearch__${spec.name}`;
  }
  invalidate(event: "tool.describe"): void {
    this.invalidated.push(event);
  }

  // -- state ------------------------------------------------------------------------

  publish(view: Partial<View>): void {
    // The engine keeps a copy: later mutations of the app's objects must not show through.
    const copy = structuredClone(view);
    // ...and refuses a value over 4 MiB of JSON text, keeping the one before.
    for (const key of Object.keys(copy) as (keyof View)[]) {
      if (JSON.stringify(copy[key]).length <= STATE_LIMIT_CHARS) continue;
      this.refusedViews.push(key);
      delete copy[key];
    }
    this.view = { ...this.view, ...copy };
    if (copy.loop) this.loop.value = copy.loop;
    this.changed();
  }
  setToolDetails(toolUseId: string, details: ToolDetails): void {
    this.toolDetails.set(toolUseId, structuredClone(details));
  }
  async loadLoop(): Promise<LoopState | undefined> {
    return this.loop.value;
  }
  async storeGet(key: string): Promise<unknown> {
    return structuredClone(this.store.get(key));
  }
  async storeSet(key: string, value: unknown): Promise<void> {
    this.store.set(key, structuredClone(value));
  }
  async storeKeys(): Promise<string[]> {
    return [...this.store.keys()];
  }
  async storeDelete(key: string): Promise<void> {
    this.store.delete(key);
  }

  // -- the browser dashboard ----------------------------------------------------------

  async post(url: string, body: string): Promise<{ status: number }> {
    this.posts.push({ url, body });
    const response = await fetch(url, { method: "POST", body });
    return { status: response.status };
  }
  async openUrl(url: string): Promise<void> {
    this.openedUrls.push(url);
  }
}

// ---------------------------------------------------------------------------
// A scripted session: the calls the engine makes on the app's handlers, in the order
// a person and the model would cause them.
// ---------------------------------------------------------------------------

export interface SessionOptions extends Partial<Options>, Omit<NodeHostOptions, "cwd"> {}

export class Session {
  readonly host: NodeHost;
  readonly app: App;
  private turns = 0;
  private toolUses = 0;
  currentTurn: string | null = null;
  /** The main conversation as the engine would hand it to session.compact. */
  transcript: CompactMessage[] = [];
  /** What our session.compact hook answered, newest last. */
  compactAnswers: unknown[] = [];

  constructor(cwd: string, options: SessionOptions = {}) {
    this.host = new NodeHost({ ...options, cwd });
    this.app = createApp(this.host, {
      compactAtPercent: options.compactAtPercent ?? 70,
      questionWaitMinutes: options.questionWaitMinutes ?? 5,
    });
    // The `/compact` the app runs raises our session.compact hook, as a person's does.
    this.host.compactHook = async () => {
      this.compactAnswers.push(await this.app.compact({ trigger: "manual", messages: this.transcript }));
    };
  }

  get ctx() {
    return this.app.ctx;
  }

  async start(): Promise<this> {
    await this.app.sessionStart();
    return this;
  }

  /** A turn of the main loop: turn.start, the body, turn.complete (`failed`: an API error ended it). */
  async turn<T>(
    body: (turnId: string) => Promise<T>,
    options: { aborted?: boolean; answer?: string; failed?: boolean } = {},
  ): Promise<T> {
    const turnId = `turn-${++this.turns}`;
    this.currentTurn = turnId;
    this.app.turnStart(turnId);
    try {
      return await body(turnId);
    } finally {
      this.currentTurn = null;
      this.app.turnComplete(options.aborted ?? false, options.answer ?? "", options.failed ?? false);
    }
  }

  nextToolUseId(): string {
    return `toolu_${String(++this.toolUses).padStart(4, "0")}`;
  }

  /** The model calling one of our tools; `agentId` makes it a subagent's call. */
  call(
    name: ToolName,
    input: Record<string, unknown>,
    signal?: AbortSignal,
    agentId?: string,
  ): Promise<ToolAnswer | { deny: string }> {
    return this.app.callTool(name, input, this.nextToolUseId(), signal, agentId);
  }

  /** As `call`, failing the test on a refusal. */
  async use(name: ToolName, input: Record<string, unknown>, signal?: AbortSignal): Promise<ToolAnswer> {
    const answer = await this.call(name, input, signal);
    if ("deny" in answer) throw new Error(`${name} refused: ${answer.deny}`);
    return answer;
  }

  /** `/autoresearch <args>`, as typed. */
  command(args: string) {
    return this.app.command(args);
  }

  /** session.end; `other` (the default) is how a crash or a restart ends it. */
  async end(reason = "other"): Promise<void> {
    await this.app.sessionEnd(reason);
    this.host.dispose();
  }

  /** The process dies: no session.end, timers gone, the store as it was. */
  crash(): void {
    this.host.dispose();
  }
}

// ---------------------------------------------------------------------------
// Repositories and processes
// ---------------------------------------------------------------------------

export type FileSpec = string | { text: string; mode?: number };

export async function writeFiles(dir: string, files: Record<string, FileSpec>): Promise<void> {
  for (const [relative, spec] of Object.entries(files)) {
    const path = nodePath.join(dir, relative);
    await fsp.mkdir(nodePath.dirname(path), { recursive: true });
    const { text, mode } = typeof spec === "string" ? { text: spec, mode: undefined } : spec;
    await fsp.writeFile(path, text);
    if (mode !== undefined) await fsp.chmod(path, mode);
  }
}

/** Runs a command to completion (test side, not through the host). */
export function sh(cwd: string, argv: string[], stdin?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawnChild(argv[0]!, argv.slice(1), { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (chunk) => (stdout += chunk));
    child.stderr!.on("data", (chunk) => (stderr += chunk));
    child.stdin!.end(stdin ?? "");
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await sh(cwd, ["git", ...args]);
  if (result.code !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

/** A temp git repository with `files` committed; `.auto/` files are left untracked. */
export async function makeRepo(files: Record<string, FileSpec> = {}, uncommitted: Record<string, FileSpec> = {}): Promise<string> {
  const dir = await fsp.realpath(await mkdtemp(nodePath.join(tmpdir(), "ar-e2e-")));
  await git(dir, "init", "-q", "-b", "main");
  await git(dir, "config", "user.email", "e2e@example.com");
  await git(dir, "config", "user.name", "e2e");
  await git(dir, "config", "commit.gpgsign", "false");
  await writeFiles(dir, { "README.md": "fixture\n", ...files });
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "-m", "init");
  await writeFiles(dir, uncommitted);
  return dir;
}

/** Removes a temp directory this suite made (never anything outside the temp folder). */
export async function removeTempDir(dir: string): Promise<void> {
  const root = await fsp.realpath(tmpdir());
  if (!dir.startsWith(root + nodePath.sep) || !nodePath.basename(dir).startsWith("ar-e2e-")) {
    throw new Error(`refusing to remove ${dir}`);
  }
  await fsp.rm(dir, { recursive: true, force: true });
}

/** Live processes whose command (argv joined) matches `pattern` from its start. */
export async function processesWith(pattern: RegExp): Promise<string[]> {
  const { stdout } = await sh("/", ["ps", "-axo", "pid=,command="]);
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => pattern.test(line.replace(/^\d+\s+/, "")));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The log's lines, parsed. */
export async function logLines(dir: string, relative = ".auto/log.jsonl"): Promise<Record<string, unknown>[]> {
  const text = await fsp.readFile(nodePath.join(dir, relative), "utf8");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** The text a tool answer gave the model, context entries after the result. */
export function textOf(answer: ToolAnswer | { deny: string }): string {
  if ("deny" in answer) return answer.deny;
  return [answer.result, ...(answer.context ?? [])].join("\n");
}
