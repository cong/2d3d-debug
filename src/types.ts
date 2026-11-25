import type * as vscode from "vscode";

/** A 3D point, optionally with RGBA color components (0–255). */
export interface Point3D {
  x: number;
  y: number;
  z: number;
  r?: number;
  g?: number;
  b?: number;
  a?: number;
}

/** Minimal shape returned by the debug adapter `evaluate` request. */
export interface EvaluateResult {
  result?: string;
  type?: string;
  variablesReference?: number;
  memoryReference?: string;
}

/** Minimal shape returned by the debug adapter `evaluate` request. */
export interface DebugVariableInfo extends EvaluateResult {
  evaluateName?: string;
  frameId?: number;
}

/** Context-menu payload from the debug variables / watch views. */
export interface SelectedDebugVariable {
  variable?: {
    name?: string;
    evaluateName?: string;
    value?: string;
    type?: string;
    variablesReference?: number;
  };
}

export type PanelWithListener = vscode.WebviewPanel & {
  _messageListener?: vscode.Disposable;
};
