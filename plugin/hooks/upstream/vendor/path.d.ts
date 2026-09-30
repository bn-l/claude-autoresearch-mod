// Types for path.js: the posix half of Node's `path`, as vendored beside this file.
export type PosixPath = {
  resolve(...paths: string[]): string
  normalize(path: string): string
  isAbsolute(path: string): boolean
  join(...paths: string[]): string
  relative(from: string, to: string): string
  dirname(path: string): string
  basename(path: string, suffix?: string): string
  extname(path: string): string
  sep: '/'
}

export declare const posix: PosixPath
export default posix
