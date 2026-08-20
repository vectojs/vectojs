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
  /**
   * Requested outer browser-window dimensions. The benchmark result's
   * `viewport` is the actual CSS content viewport measured by the page.
   */
  viewport: Viewport | null;
  iterations: number;
  profileState: ProfileState;
  mode: BenchmarkMode;
  /**
   * Extra query parameters appended to the benchmark URL by `--param k=v`.
   *
   * Benchmark entries read their own knobs off `location.search` (glyph counts,
   * `hud`, `holdMs`, …), so without a passthrough a phase gated behind one of
   * them is simply unreachable through the harness — and therefore unquotable,
   * since only the harness produces the `BenchmarkResult` envelope. Keys that
   * the runner itself owns are rejected at parse time rather than silently
   * overridden.
   */
  params: Readonly<Record<string, string>>;
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
  /**
   * Write whatever profile state the browser needs before launch.
   *
   * `panelHz` is the display's refresh rate, or null when it could not be
   * determined. Firefox needs it: its `layout.frame_rate` default of -1 means
   * "follow the display" and resolves to 60 Hz on this Hyprland/Wayland host even
   * with the window focused, so without an explicit value every Firefox run
   * measures a 60 Hz page on a 240 Hz panel. See {@link FirefoxAdapter}.
   */
  prepareProfile(profileDir: string, panelHz?: number | null): Promise<void>;
  launchSpec(
    profileDir: string,
    url: string,
    /** Native outer-window dimensions, not CSS content viewport dimensions. */
    viewport: Viewport | null,
    mode?: BenchmarkMode,
  ): BrowserLaunchSpec;
}

export interface WindowController {
  activeWorkspace(): Promise<number>;
  /**
   * The display's refresh rate in Hz, or null when it cannot be determined.
   *
   * On the compositor interface because the compositor is the only thing that
   * knows it, and because a browser has to be *told* it: Firefox's
   * `layout.frame_rate` default of -1 resolves to 60 Hz here regardless of focus.
   * Never hardcode a rate — a benchmark on a 60 Hz or 144 Hz panel must get that
   * panel's rate, not this host's.
   */
  panelRefreshHz(): Promise<number | null>;
  launch(workspace: number, spec: BrowserLaunchSpec): Promise<void>;
  find(workspace: number, className: string, titleFragment: string): Promise<string | null>;
  processId?(address: string): Promise<number | null>;
  focusWorkspace(workspace: number): Promise<void>;
  focusWindow(address: string): Promise<void>;
  closeWindow(address: string): Promise<void>;
}
