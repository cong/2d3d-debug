import * as vscode from "vscode";
import { drawMatImage } from "./2d/cpp2d";
import { showPythonImageViewer } from "./2d/py2d";
import { getHtml } from "./2d/pyWebview";
import { drawPointCloud, drawPointCloudPCL } from "./3d/cpp3d";
import {
  drawNumpyXYZPointCloud,
  drawOpen3DPointCloud,
} from "./3d/py3d";
import {
  evaluateVariable,
  getActiveFrameId,
  isPythonDebugSession,
} from "./utils/debugger";
import {
  detectPythonView,
  isMat,
  isPCL,
  isPoint3Vector,
} from "./utils/judge";
import { loadWebview } from "./utils/panel";
import type { SelectedDebugVariable } from "./types";

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "extension.viewVariable",
      async (selectedVariable: SelectedDebugVariable) => {
        const debugSession = vscode.debug.activeStackItem?.session ?? vscode.debug.activeDebugSession;
        if (!debugSession) {
          vscode.window.showErrorMessage("No active debug session.");
          return;
        }

        try {
          const variable = selectedVariable?.variable;
          if (!variable?.name && !variable?.evaluateName) {
            vscode.window.showErrorMessage("No variable selected.");
            return;
          }

          const frameId = await getActiveFrameId(debugSession);
          const variableName = variable.evaluateName ?? variable.name!;
          if (isPythonDebugSession(debugSession)) {
            const kind = await detectPythonView(debugSession, variableName, frameId);
            switch (kind) {
              case "numpy-xyz":
                await drawNumpyXYZPointCloud(debugSession, frameId, variableName);
                break;
              case "point-cloud":
                await drawOpen3DPointCloud(debugSession, frameId, variableName);
                break;
              case "image":
                await showPythonImageViewer(debugSession, variableName, frameId);
                break;
              default:
                vscode.window.showErrorMessage("Variable is not a supported type.");
            }
            return;
          }

          const variableInfo = await evaluateVariable(debugSession, variableName, frameId, variable);
          const point3Info = isPoint3Vector(variableInfo);
          const pclInfo = isPCL(variableInfo);
          if (point3Info.isPoint3) {
            await drawPointCloud(
              debugSession,
              variableInfo,
              variableName,
              point3Info.isDouble
            );
          } else if (isMat(variableInfo)) {
            await drawMatImage(debugSession, variableInfo, frameId, variableName);
          } else if (pclInfo.isPCL) {
            await drawPointCloudPCL(
              debugSession,
              variableInfo,
              variableName,
              pclInfo.hasRGB
            );
          } else {
            vscode.window.showErrorMessage("Variable is not a supported type.");
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          vscode.window.showErrorMessage(`Error: ${message}`);
        }
      }
    ),
    vscode.commands.registerCommand(
      "imageViewer.viewImageFile",
      async (uri?: vscode.Uri) => {
        try {
          let fileUri: vscode.Uri;

          if (uri?.scheme === "file") {
            fileUri = uri;
          } else {
            const picked = await vscode.window.showOpenDialog({
              canSelectMany: false,
              filters: { Images: ["jpg", "jpeg", "png", "bmp", "gif"] },
            });
            if (!picked?.length) {
              return;
            }
            fileUri = picked[0];
          }

          await vscode.workspace.fs.stat(fileUri);
          const panel = vscode.window.createWebviewPanel(
            "Image",
            `Image: ${fileUri.fsPath}`,
            vscode.ViewColumn.Active,
            {
              enableScripts: true,
              retainContextWhenHidden: true,
              localResourceRoots: [vscode.Uri.joinPath(fileUri, "..")],
            }
          );

          const imgUri = panel.webview.asWebviewUri(fileUri);
          loadWebview(panel, getHtml(), { command: "show", uri: imgUri.toString() });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          vscode.window.showErrorMessage(`Error viewing image: ${message}`);
        }
      }
    )
  );
}

export function deactivate(): void {}
