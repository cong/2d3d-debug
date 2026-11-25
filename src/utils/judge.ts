import type * as vscode from "vscode";
import { EVALUATE_TIMEOUT_MS } from "../constants";
import { evaluateWithTimeout } from "./debugger";
import type { DebugVariableInfo } from "../types";

export function isPoint3Vector(
  variableInfo: DebugVariableInfo
): { isPoint3: boolean; isDouble: boolean } {
  const type = variableInfo.type ?? "";

  const isDouble =
    type.includes("std::vector<cv::Point3d>") ||
    type.includes("std::vector<cv::Point3_<double>") ||
    type.includes("std::__1::vector<cv::Point3_<double>") ||
    type.includes("class std::vector<class cv::Point3_<double>") ||
    /std::.*vector\s*<\s*cv::Point3d\s*>/.test(type) ||
    /std::.*vector\s*<\s*cv::Point3_<double>/.test(type);

  const isFloat =
    type.includes("std::vector<cv::Point3f>") ||
    type.includes("std::vector<cv::Point3_<float>") ||
    type.includes("std::__1::vector<cv::Point3_<float>") ||
    type.includes("class std::vector<class cv::Point3_<float>") ||
    /std::.*vector\s*<\s*cv::Point3f\s*>/.test(type) ||
    /std::.*vector\s*<\s*cv::Point3_<float>/.test(type);

  const isGeneric = /std::.*vector\s*<\s*cv::Point3[fd]?\s*>/.test(type);
  return { isPoint3: isDouble || isFloat || isGeneric, isDouble };
}

export function isMat(variableInfo: DebugVariableInfo): boolean {
  const type = variableInfo.type ?? "";
  return (
    type.includes("cv::Mat") ||
    type.includes("class cv::Mat") ||
    /cv::Mat_</.test(type) ||
    /cv::Mat\b/.test(type)
  );
}

export function isPCL(
  variableInfo: DebugVariableInfo
): { isPCL: boolean; hasRGB: boolean } {
  if (!variableInfo.type && !variableInfo.result) {
    return { isPCL: false, hasRGB: false };
  }

  const type = (variableInfo.type ?? "").trim();
  const result = variableInfo.result ?? "";

  let normalizedType = type;
  if (/::Ptr(?:\s*=\s*shared_ptr<.*>)?$/.test(type)) {
    normalizedType = type.replace(/::Ptr(?:\s*=\s*shared_ptr<.*>)?$/, "").trim();
  }

  const isPCLType =
    normalizedType.includes("pcl::PointCloud<") ||
    normalizedType.includes("class pcl::PointCloud<") ||
    /^PointCloud<.*>/.test(normalizedType) ||
    (/PointCloud<.*>.*\bpoints\b/.test(result) && result.includes("<"));

  if (!isPCLType) {
    return { isPCL: false, hasRGB: false };
  }

  let pointTypeName = "";
  const typeMatch = normalizedType.match(
    /pcl::PointCloud<\s*(?:pcl::)?([^>\s]+)\s*>/
  );
  if (typeMatch) {
    pointTypeName = typeMatch[1];
  } else {
    const resultMatch = result.match(/PointCloud<\s*([^>\s]+)\s*>/);
    if (resultMatch) {
      pointTypeName = resultMatch[1];
    }
  }

  pointTypeName = pointTypeName.replace(/^class\s+/, "");
  const hasRGB =
    pointTypeName === "PointXYZRGB" ||
    pointTypeName === "PointXYZRGBA" ||
    pointTypeName === "pcl::PointXYZRGB" ||
    pointTypeName === "pcl::PointXYZRGBA";

  return { isPCL: true, hasRGB };
}

export function getBytesPerElement(depth: number): number {
  switch (depth) {
    case 0:
    case 1:
      return 1;
    case 2:
    case 3:
      return 2;
    case 4:
    case 5:
      return 4;
    case 6:
      return 8;
    default:
      return 1;
  }
}

export type PythonViewKind = "image" | "numpy-xyz" | "point-cloud";

export async function detectPythonView(
  debugSession: vscode.DebugSession,
  variableName: string,
  frameId: number
): Promise<PythonViewKind | undefined> {
  // Evaluate the selected expression once. Inspect class names without importing
  // optional Python packages into the program being debugged.
  const expression = [
    "(lambda obj: (lambda classes:",
    "(2 if obj.ndim == 2 and obj.shape[1] == 3 else 1)",
    "if ('numpy', 'ndarray') in classes else",
    "1 if ('PIL.Image', 'Image') in classes or ('torch', 'Tensor') in classes else",
    "3 if hasattr(obj, 'points') else 0)",
    "(tuple((cls.__module__, cls.__name__) for cls in type(obj).__mro__)))",
    `((${variableName}))`,
  ].join(" ");

  const response = await evaluateWithTimeout(debugSession, expression, frameId, EVALUATE_TIMEOUT_MS);
  switch (response.result?.trim()) {
    case "1": return "image";
    case "2": return "numpy-xyz";
    case "3": return "point-cloud";
    default: return undefined;
  }
}
