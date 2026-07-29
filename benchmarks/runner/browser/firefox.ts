import { join } from 'node:path';
import type { BrowserAdapter, BrowserLaunchSpec, Viewport } from '../types';
import { firstExecutable } from './interface';

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
  public readonly profiler = null;

  public constructor(private readonly executableOverride?: string) {}

  public resolveExecutable(): string | null {
    return this.executableOverride ?? firstExecutable(['firefox']);
  }

  public async prepareProfile(profileDir: string): Promise<void> {
    await Bun.write(join(profileDir, 'user.js'), PROFILE_PREFERENCES);
  }

  public launchSpec(profileDir: string, url: string, viewport: Viewport | null): BrowserLaunchSpec {
    const executable = this.resolveExecutable();
    if (!executable) throw new Error('firefox is not installed');
    const args = ['--new-instance', '--profile', profileDir];
    if (viewport) args.push(`--width=${viewport.width}`, `--height=${viewport.height}`);
    args.push('--private-window', url);
    return { executable, args, windowClass: 'firefox' };
  }
}
