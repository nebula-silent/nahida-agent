// 5.6.1：好感度变更日志（log.jsonl 追加写）
// 依据：内部规格 §3.3
// 结构参考自 long-term-store.ts（5.1.2 产出）：目录显式入参、路径只在 store 内部拼
// 硬规则（指令 §2.6）：追加写（appendFileSync + \n），绝不许读整份再写回；
//   写失败只 console.error，不抛、不回滚 state —— 日志是旁路，不能拖垮真相落盘。
import * as fs from "fs";
import * as path from "path";
import type { RelationshipLogEntry } from "../../shared/relationship";

function logFile(dir: string): string {
  return path.join(dir, "relationship", "log.jsonl");
}

/** 追加一行到 log.jsonl（mkdir + appendFileSync）；失败只 console.error，不抛、不回滚 state */
export function appendRelationshipLog(dir: string, entry: RelationshipLogEntry): void {
  try {
    const file = logFile(dir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(entry) + "\n", "utf8");
  } catch (err) {
    console.error("[relationship] log.jsonl 追加失败（state 已落盘，不回滚）:", err);
  }
}

/** 末 N 条（默认 50），给单测与排查用；文件不存在 → []。坏行跳过不抛（日志是旁路，读不出错也 tolerate）。 */
export function readRelationshipLog(dir: string, limit = 50): RelationshipLogEntry[] {
  try {
    const file = logFile(dir);
    if (!fs.existsSync(file)) return [];
    const lines = fs.readFileSync(file, "utf8").split("\n");
    const out: RelationshipLogEntry[] = [];
    for (const line of lines) {
      const t = line.trim();
      if (t === "") continue;
      try {
        out.push(JSON.parse(t) as RelationshipLogEntry);
      } catch {
        console.warn("[relationship] log.jsonl 有坏行，已跳过");
      }
    }
    return out.slice(-limit);
  } catch (err) {
    console.error("[relationship] log.jsonl 读取失败，按空日志处理:", err);
    return [];
  }
}
