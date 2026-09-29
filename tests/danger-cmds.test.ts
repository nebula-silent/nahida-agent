// 8.4 §1.2：shell 危险命令黑名单单测 —— 正常命令不误伤、破坏性命令 + 参数变体命中。
import { describe, it, expect } from "vitest";
import { isDangerousShell } from "../src/main/tools/danger-cmds";

describe("isDangerousShell", () => {
  it("普通命令放行：node / git / ls / npm / 非递归 rm", () => {
    expect(isDangerousShell(["node", "--version"]).dangerous).toBe(false);
    expect(isDangerousShell(["git", "status"]).dangerous).toBe(false);
    expect(isDangerousShell(["ls", "-la"]).dangerous).toBe(false);
    expect(isDangerousShell(["npm", "install"]).dangerous).toBe(false);
    expect(isDangerousShell(["rm", "notes.txt"]).dangerous).toBe(false); // 单文件删除：不是递归
    expect(isDangerousShell(["del", "a.txt"]).dangerous).toBe(false);
    expect(isDangerousShell([]).dangerous).toBe(false);
  });

  it("Unix 递归删除：rm -rf / 及其变体命中", () => {
    for (const argv of [
      ["rm", "-rf", "/"],
      ["rm", "-r", "/"],
      ["rm", "-fr", "/home"],
      ["rm", "-R", "/var"],
      ["rm", "--recursive", "/tmp/x"],
      ["rm", "-rf", "."],
      ["rm", "-rf", "*"],
      ["RM", "-RF", "/"],
    ]) {
      expect(isDangerousShell(argv).dangerous, argv.join(" ")).toBe(true);
    }
    expect(isDangerousShell(["rm", "-rf", "/"]).reason).toContain("递归删除");
  });

  it("Windows 递归删除：rd / rmdir / del 的大小写与参数组合变体命中", () => {
    for (const argv of [
      ["rd", "/s", "/q", "C:\\"],
      ["RD", "/S", "/Q", "D:\\"],
      ["rmdir", "/s", "C:\\Users\\me\\tmp"],
      ["del", "/f", "/s", "/q", "C:\\"],
      ["del", "/f", "/q", "C:\\temp\\a.txt"],
    ]) {
      expect(isDangerousShell(argv).dangerous, argv.join(" ")).toBe(true);
    }
    expect(isDangerousShell(["rd", "/s", "/q", "C:\\"]).reason).toContain("递归删除");
  });

  it("PowerShell：Remove-Item -Recurse 与 Format-* 命中", () => {
    expect(isDangerousShell(["Remove-Item", "-Recurse", "C:\\"]).dangerous).toBe(true);
    expect(isDangerousShell(["Remove-Item", "-RECURSE", "D:\\proj"]).dangerous).toBe(true);
    expect(isDangerousShell(["Format-Volume", "-DriveLetter", "D"]).dangerous).toBe(true);
  });

  it("磁盘级命令与 fork 炸弹命中", () => {
    expect(isDangerousShell(["format", "D:"]).dangerous).toBe(true);
    expect(isDangerousShell(["diskpart"]).dangerous).toBe(true);
    expect(isDangerousShell(["mkfs.ext4", "/dev/sda1"]).dangerous).toBe(true);
    expect(isDangerousShell([":(){ :|:& };:"]).dangerous).toBe(true);
  });

  it("壳内命令穿透：bash -c / cmd /c / powershell -Command 里的正文再判一次", () => {
    expect(isDangerousShell(["bash", "-c", "rm -rf /"]).dangerous).toBe(true);
    expect(isDangerousShell(["cmd", "/c", "del /f /s /q C:\\"]).dangerous).toBe(true);
    expect(isDangerousShell(["powershell", "-Command", "Remove-Item -Recurse C:\\"]).dangerous).toBe(true);
    expect(isDangerousShell(["bash", "-c", "node --version"]).dangerous).toBe(false);
  });

  it("危险组合：工作目录是盘根时措辞标明盘根", () => {
    const verdict = isDangerousShell(["rm", "-rf", "build"], "C:\\");
    expect(verdict.dangerous).toBe(true);
    expect(verdict.reason).toContain("盘根");
  });
});