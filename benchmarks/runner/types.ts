export type BrowserName = 'chrome' | 'firefox';
export type BenchmarkMode = 'measure' | 'profile';
export type ProfileState = 'cold' | 'warm';

export interface Viewport {
  width: number;
  height: number;
}

export interface RunnerConfig {
  benchDir: string;
  port: number;
  /**
   * Explicit `--workspace N` override, or `null` to use the per-engine default
   * from `ENGINE_WORKSPACE` (Chrome 5, Firefox 6). Resolved per engine at launch
   * because one invocation can run both browsers.
   */
  workspace: number | null;
  keepGoing: boolean;
  viewport: Viewport | null;
  iterations: number;
  profileState: ProfileState;
  mode: BenchmarkMode;
  browsers: BrowserName[];
  timeoutMs: number;
  extendMs: number;
}

export interface BrowserProfileOptions {
  profileDir: string;
  targetUrl: string;
  tracePath: string;
  signal: AbortSignal;
}

export interface BrowserProfileArtifact {
  tracePath: string;
  dataLossOccurred: boolean;
}

export interface BrowserProfileSession {
  readonly stopAfterBrowserExit: boolean;
  readonly shutdownGraceMs: number;
  releaseBenchmark(): Promise<void>;
  stop(): Promise<BrowserProfileArtifact>;
}

export interface BrowserProfiler {
  readonly gate: boolean;
  prepare(options: BrowserProfileOptions): Promise<Readonly<Record<string, string>>>;
  start(options: BrowserProfileOptions): Promise<BrowserProfileSession>;
}

export interface BrowserLaunchSpec {
  executable: string;
  args: string[];
  environment?: Readonly<Record<string, string>>;
  windowClass: string;
}

export interface BrowserAdapter {
  readonly name: BrowserName;
  readonly profiler: BrowserProfiler | null;
  resolveExecutable(): string | null;
  prepareProfile(profileDir: string): Promise<void>;
  launchSpec(
    profileDir: string,
    url: string,
    viewport: Viewport | null,
    mode?: BenchmarkMode,
  ): BrowserLaunchSpec;
}

export interface WindowController {
  activeWorkspace(): Promise<number>;
  launch(workspace: number, spec: BrowserLaunchSpec): Promise<void>;
  find(workspace: number, className: string, titleFragment: string): Promise<string | null>;
  processId?(address: string): Promise<number | null>;
  focusWorkspace(workspace: number): Promise<void>;
  focusWindow(address: string): Promise<void>;
  closeWindow(address: string): Promise<void>;
}
