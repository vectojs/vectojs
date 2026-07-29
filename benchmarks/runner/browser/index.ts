import type { BrowserName } from '../types';
import { ChromeAdapter } from './chrome';
import { FirefoxAdapter } from './firefox';
import type { BrowserAdapter } from './interface';

export function browserAdapter(name: BrowserName): BrowserAdapter {
  return name === 'chrome' ? new ChromeAdapter() : new FirefoxAdapter();
}
