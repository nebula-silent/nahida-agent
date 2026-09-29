// 3.3 提取：原子写 JSON —— 全项目唯一一份（3.2 config-store / 3.3 chats-store 共用）。
// 同目录 .tmp + rename：rename 在同一文件系统内是原子替换；写一半崩了只丢 .tmp，
// 主文件要么是旧内容要么是新内容，不会出现写了一半的半个 JSON。
import * as fs from "fs";

export function atomicWriteJson(filePath: string, data: unknown): void {
  const tmpPath = filePath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmpPath, filePath); // 同目录 rename 是原子替换
}
