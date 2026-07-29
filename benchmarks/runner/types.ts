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
  workspace: number;
  keepGoing: boolean;
  viewport: Viewport | null;
  iterations: number;
  profileState: ProfileState;
  mode: BenchmarkMode;
  browsers: BrowserName[];
  timeoutMs: number;
  extendMs: number;
}

export interface BrowserLaunchSpec {
  executable: string;
  args: string[];
  windowClass: string;
}

export interface BrowserAdapter {
  readonly name: BrowserName;
  resolveExecutable(): string | null;
  prepareProfile(profileDir: string): Promise<void>;
  launchSpec(profileDir: string, url: string, viewport: Viewport | null): BrowserLaunchSpec;
}

export interface WindowController {
  activeWorkspace(): Promise<number>;
  launch(workspace: number, spec: BrowserLaunchSpec): Promise<void>;
  find(workspace: number, className: string, titleFragment: string): Promise<string | null>;
  focusWorkspace(workspace: number): Promise<void>;
  focusWindow(address: string): Promise<void>;
  closeWindow(address: string): Promise<void>;
}
