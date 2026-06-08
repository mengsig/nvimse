import { NvimseConfig, readConfig } from "./config";

let _config: NvimseConfig | null = null;
let _disabled = false;
let _trustedDepth = 0;

export function refreshConfig(): NvimseConfig {
  _config = readConfig();
  return _config;
}

export function config(): NvimseConfig {
  if (!_config) _config = readConfig();
  return _config;
}

export function isDisabled(): boolean {
  return _disabled;
}

export function setDisabled(v: boolean): void {
  _disabled = v;
}

export function withTrusted<T>(fn: () => T): T {
  _trustedDepth++;
  try {
    return fn();
  } finally {
    _trustedDepth--;
  }
}

export function trustedDepth(): number {
  return _trustedDepth;
}
