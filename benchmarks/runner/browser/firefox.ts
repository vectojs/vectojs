import { join } from 'node:path';
import { prepareFirefoxProfile, startFirefoxProfile } from '../profile/firefox';
import type { BrowserAdapter, BrowserLaunchSpec, BrowserProfiler, Viewport } from '../types';
import { firstExecutable } from './interface';

/**
 * Pin Firefox's frame rate to the display's, because its default does not.
 *
 * `layout.frame_rate` defaults to -1, "follow the display", and on this
 * Hyprland/Wayland host that resolves to 60 Hz on a 240 Hz panel — with the window
 * focused, on the active workspace, on the focused monitor. Measured 2026-08-03
 * with a standalone probe (no benchmark runner, no VectoJS): seven Firefox launches
 * with a fresh profile each, every 500 ms rAF bucket of every launch between 58.1
 * and 61.9 Hz, never once rising, while `document.hasFocus()` was true and
 * `visibilityState` was `visible`. The same probe gave Chromium ~240 Hz from its
 * first bucket on 3/3 launches, so the panel and the compositor were delivering.
 * Setting this pref to 240 gave 2/2 Firefox launches ~240 Hz from the first bucket.
 *
 * This is why the defect looked like a focus race and was not one: there is no
 * late-arriving cadence to wait for, so no amount of gating in the runner or the
 * page could have fixed it. Every Firefox `measure` row this harness produced
 * before this pref was sampling a 60 Hz page.
 *
 * The rate is passed in, never hardcoded — a 144 Hz laptop must get 144, and
 * baking this host's 240 into the harness is the same class of error as the
 * hardcoded 60 Hz that made starvation detection blind. `0` is not an option
 * either: it unthrottles rAF entirely (measured 820-1044 Hz), which decouples it
 * from vsync and measures something no user will ever see.
 */
function framePreference(panelHz: number | null | undefined): string {
  if (typeof panelHz !== 'number' || !Number.isFinite(panelHz) || panelHz <= 0) return '';
  return `// Firefox's -1 default ("follow the display") reads 60Hz on this
// compositor even when focused, so the panel's real rate is stated explicitly.
user_pref("layout.frame_rate", ${Math.round(panelHz)});
`;
}

const PROFILE_PREFERENCES = `// Suppress first-run and privacy-notice windows.
user_pref("browser.startup.homepage_override.mstone", "ignore");
user_pref("startup.homepage_welcome_url", "");
user_pref("startup.homepage_welcome_url.additional", "");
user_pref("startup.homepage_override_url", "");
user_pref("browser.aboutwelcome.enabled", false);
user_pref("browser.messaging-system.whatsNewPanel.enabled", false);
user_pref("browser.privatebrowsing.vpnpromourl", "");
user_pref("privacy.trackingprotection.introURL", "");
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("datareporting.policy.firstRunURL", "");
user_pref("trailhead.firstrun.didSeeAboutWelcome", true);
// Suppress restore, crash-report, and default-browser prompts.
user_pref("browser.sessionstore.resume_from_crash", false);
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);
`;

export class FirefoxAdapter implements BrowserAdapter {
  public readonly name = 'firefox';
  public readonly profiler: BrowserProfiler = {
    gate: false,
    prepare: prepareFirefoxProfile,
    start: startFirefoxProfile,
  };

  public constructor(private readonly executableOverride?: string) {}

  public resolveExecutable(): string | null {
    return this.executableOverride ?? firstExecutable(['firefox']);
  }

  public async prepareProfile(profileDir: string, panelHz?: number | null): Promise<void> {
    await Bun.write(join(profileDir, 'user.js'), PROFILE_PREFERENCES + framePreference(panelHz));
  }

  public launchSpec(profileDir: string, url: string, viewport: Viewport | null): BrowserLaunchSpec {
    const executable = this.resolveExecutable();
    if (!executable) throw new Error('firefox is not installed');
    const args = ['--new-instance', '--profile', profileDir];
    // Firefox's launch dimensions are native window geometry. Browser chrome and
    // compositor decorations can leave a different CSS content viewport; the page
    // records window.innerWidth/innerHeight in the result envelope.
    if (viewport) args.push(`--width=${viewport.width}`, `--height=${viewport.height}`);
    args.push('--private-window', url);
    return { executable, args, windowClass: 'firefox' };
  }
}
