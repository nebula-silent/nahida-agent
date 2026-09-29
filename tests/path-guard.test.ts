// 8.4 §1.3：敏感区路径守卫单测 —— 穿越 / 敏感文件名 / 系统盘根全拒且 reason 可读。
// 8.2 §1.2：白名单单测 —— 只放行 allowedDirs 内，敏感区优先（白名单也救不回来）。
import { describe, it, expect } from "vitest";
import { isAllowedPath, isSensitivePath } from "../src/main/tools/path-guard";

describe("isSensitivePath", () => {
  it("普通项目路径放行", () => {
    expect(isSensitivePath("C:\\Users\\me\\Documents\\notes.txt").blocked).toBe(false);
    expect(isSensitivePath("D:\\projects\\app\\src\\index.ts").blocked).toBe(false);
    // 盘根一级不是系统目录名时不许误伤（D:\projects\windows\app.ts）
    expect(isSensitivePath("D:\\projects\\windows\\app.ts").blocked).toBe(false);
  });

  it("盘根 / 根目录拒绝", () => {
    for (const p of ["C:\\", "D:\\", "C:", "/", "\\"]) {
      const v = isSensitivePath(p);
      expect(v.blocked, p).toBe(true);
      expect(v.reason).toContain("盘根");
    }
  });

  it("Windows 系统目录 / Program Files 拒绝", () => {
    expect(isSensitivePath("C:\\Windows\\System32\\cmd.exe").blocked).toBe(true);
    expect(isSensitivePath("C:\\WINDOWS\\Temp").blocked).toBe(true);
    expect(isSensitivePath("C:\\Program Files\\app\\x.dll").blocked).toBe(true);
    expect(isSensitivePath("C:\\Program Files (x86)\\app").blocked).toBe(true);
  });

  it("AppData 默认拒绝；在白名单目录内才放行", () => {
    const target = "C:\\Users\\me\\AppData\\Roaming\\nahida\\config.json";
    expect(isSensitivePath(target).blocked).toBe(true);
    expect(isSensitivePath(target, ["C:\\Users\\me\\AppData\\Roaming\\nahida"]).blocked).toBe(false);
    // 白名单之外的 AppData 子路径仍拒
    expect(isSensitivePath("C:\\Users\\me\\AppData\\Local\\Temp\\x", ["C:\\Users\\me\\AppData\\Roaming\\nahida"]).blocked).toBe(true);
  });

  it("凭据类文件名拒绝", () => {
    for (const p of [
      "C:\\proj\\.env",
      "C:\\proj\\.env.local",
      "C:\\proj\\server.key",
      "C:\\proj\\cert.pem",
      "C:\\x\\id_rsa",
      "C:\\x\\token",
      "C:\\x\\credentials.json",
      "C:\\x\\secrets.yaml",
    ]) {
      const v = isSensitivePath(p);
      expect(v.blocked, p).toBe(true);
      expect(v.reason).toContain("敏感区");
    }
    // 名字里恰含这些词根但不是凭据文件的不误伤
    expect(isSensitivePath("C:\\x\\tokenizer.py").blocked).toBe(false);
    expect(isSensitivePath("C:\\x\\notes.md").blocked).toBe(false);
  });

  it("`..` 穿越：规范化后落到敏感区照样拒", () => {
    expect(isSensitivePath("C:\\Users\\me\\..\\..\\Windows\\System32\\x.dll").blocked).toBe(true);
    expect(isSensitivePath("D:\\proj\\..\\..\\..\\Windows\\x").blocked).toBe(true);
  });

  it("相对路径 / 空路径：基准不明一律拒（绝对路径逃逸）", () => {
    expect(isSensitivePath("..\\..\\Windows").blocked).toBe(true);
    expect(isSensitivePath("notes.txt").blocked).toBe(true);
    expect(isSensitivePath("").blocked).toBe(true);
    expect(isSensitivePath("   ").blocked).toBe(true);
  });
});

describe("isAllowedPath（8.2 白名单）", () => {
  it("白名单内放行：目录本身 + 递归子文件", () => {
    expect(isAllowedPath("D:\\work\\a.md", ["D:\\work"]).allowed).toBe(true);
    expect(isAllowedPath("D:\\work", ["D:\\work"]).allowed).toBe(true);
    expect(isAllowedPath("D:\\work\\sub\\deep.txt", ["D:\\work\\other", "D:\\work"]).allowed).toBe(true);
  });

  it("白名单外拒绝（reason 不含原文路径）", () => {
    const v = isAllowedPath("D:\\other\\a.md", ["D:\\work"]);
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain("不在允许");
    expect(v.reason).not.toContain("D:\\other\\a.md");
  });

  it("未配置目录 → 全拒", () => {
    for (const dirs of [[], [""], ["   "]]) {
      const v = isAllowedPath("D:\\work\\a.md", dirs);
      expect(v.allowed, JSON.stringify(dirs)).toBe(false);
      expect(v.reason).toContain("没有配置");
    }
  });

  it("`..` 穿越：规范化后落在白名单内就放行、落在外就拒", () => {
    expect(isAllowedPath("D:\\work\\sub\\..\\a.md", ["D:\\work"]).allowed).toBe(true);
    expect(isAllowedPath("D:\\work\\..\\other\\a.md", ["D:\\work"]).allowed).toBe(false);
  });

  it("敏感区优先：白名单也救不回来", () => {
    expect(isAllowedPath("C:\\Windows\\x.dll", ["C:\\Windows"]).allowed).toBe(false);
    expect(isAllowedPath("D:\\work\\.env", ["D:\\work"]).allowed).toBe(false);
    expect(isAllowedPath("D:\\work\\id_rsa", ["D:\\work"]).allowed).toBe(false);
    expect(isAllowedPath("D:\\", ["D:\\"]).allowed).toBe(false); // 盘根永远是敏感区
  });

  it("相对路径 / 空路径拒绝", () => {
    expect(isAllowedPath("a.md", ["D:\\work"]).allowed).toBe(false);
    expect(isAllowedPath("", ["D:\\work"]).allowed).toBe(false);
    expect(isAllowedPath("   ", ["D:\\work"]).allowed).toBe(false);
  });
});