export type { WindowController } from '../types';

export interface HyprlandClient {
  address: string;
  className: string;
  title: string;
  workspace: number;
  pid?: number;
}
