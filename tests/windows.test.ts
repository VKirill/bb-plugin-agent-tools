import { test } from "node:test";
import assert from "node:assert/strict";
import { binCandidates, isWindowsAbsPath, needsCmdWrapper, unwrapShell, wrapForWindows } from "../platform.ts";
import { classifyLocal, classifyRole, sameServer } from "../normalize.ts";
import { gitBinSearchDirs } from "../i18n.ts";
import type { McpServer } from "../contract.ts";

const stdio = (command: string, args?: string[]): McpServer => ({
  name: "x",
  transport: "stdio",
  command,
  args,
});

test("binCandidates tries PATHEXT extensions on win32", () => {
  assert.deepEqual(binCandidates("git", "win32", ".COM;.EXE;.BAT;.CMD"), [
    "git.com",
    "git.exe",
    "git.bat",
    "git.cmd",
    "git",
  ]);
  assert.deepEqual(binCandidates("claude", "win32", undefined).slice(0, 2), ["claude.com", "claude.exe"]);
  assert.deepEqual(binCandidates("claude.exe", "win32", ".COM;.EXE"), ["claude.exe"]);
});

test("binCandidates keeps the bare name elsewhere", () => {
  assert.deepEqual(binCandidates("git", "linux", ".EXE"), ["git"]);
  assert.deepEqual(binCandidates("git", "darwin"), ["git"]);
});

test("isWindowsAbsPath recognises drive and UNC paths only", () => {
  assert.equal(isWindowsAbsPath("C:\\Users\\x"), true);
  assert.equal(isWindowsAbsPath("c:/Users/x"), true);
  assert.equal(isWindowsAbsPath("\\\\host\\share"), true);
  assert.equal(isWindowsAbsPath("/usr/bin/x"), false);
  assert.equal(isWindowsAbsPath("npx"), false);
  assert.equal(isWindowsAbsPath("C:foo"), false);
});

test("unwrapShell strips cmd /c and leaves everything else alone", () => {
  assert.deepEqual(unwrapShell("cmd", ["/c", "npx", "-y", "pkg"]), { command: "npx", args: ["-y", "pkg"] });
  assert.deepEqual(unwrapShell("CMD.EXE", ["/d", "/s", "/C", "tool"]), { command: "tool", args: undefined });
  assert.deepEqual(unwrapShell("C:\\Windows\\System32\\cmd.exe", ["/c", "a", "b"]), { command: "a", args: ["b"] });
  assert.deepEqual(unwrapShell("npx", ["-y", "pkg"]), { command: "npx", args: ["-y", "pkg"] });
  assert.deepEqual(unwrapShell("cmd", ["/k", "x"]), { command: "cmd", args: ["/k", "x"] });
});

test("needsCmdWrapper flags bare names and .cmd/.bat", () => {
  assert.equal(needsCmdWrapper("npx"), true);
  assert.equal(needsCmdWrapper("C:\\x\\run.CMD"), true);
  assert.equal(needsCmdWrapper("C:\\x\\tool.exe"), false);
  assert.equal(needsCmdWrapper("tool.exe"), false);
  assert.equal(needsCmdWrapper("C:\\x\\tool"), false);
});

test("wrapForWindows wraps npx, keeps exe, cmd and http servers", () => {
  assert.deepEqual(wrapForWindows(stdio("npx", ["-y", "pkg"])), stdio("cmd", ["/c", "npx", "-y", "pkg"]));
  assert.deepEqual(wrapForWindows(stdio("gitnexus")), stdio("cmd", ["/c", "gitnexus"]));
  const exe = stdio("C:\\x\\tool.exe", ["a"]);
  assert.equal(wrapForWindows(exe), exe);
  const wrapped = stdio("cmd", ["/c", "npx", "-y", "pkg"]);
  assert.equal(wrapForWindows(wrapped), wrapped);
  const http: McpServer = { name: "h", transport: "http", url: "https://example.com/mcp" };
  assert.equal(wrapForWindows(http), http);
});

test("classifyLocal marks Windows machine-bound entries", () => {
  assert.equal(classifyLocal(stdio("C:/Users/x/.venv/Scripts/python.exe", ["-m", "srv"])).localOnly, true);
  const byArg = classifyLocal(stdio("node", ["C:\\Users\\x\\server.js"]));
  assert.equal(byArg.localOnly, true);
  assert.match(byArg.reason, /аргумент с локальным путём/);
  const wrapped = classifyLocal(stdio("cmd", ["/c", "C:\\Users\\x\\.agents\\bin\\metamcp-run.cmd"]));
  assert.equal(wrapped.localOnly, true);
  assert.match(wrapped.reason, /абсолютный путь: C:\\Users/);
  const app = classifyLocal(stdio("C:\\Users\\x\\AppData\\Local\\Programs\\Cursor\\resources\\srv.exe"));
  assert.match(app.reason, /внутри приложения/);
  assert.equal(classifyLocal(stdio("cmd", ["/c", "npx", "-y", "pkg"])).localOnly, false);
});

test("classifyRole sees the MetaMCP gateway behind cmd /c and Windows app dirs as vendor", () => {
  assert.equal(classifyRole(stdio("cmd", ["/c", "C:\\Users\\x\\.agents\\bin\\metamcp-run.cmd"])), "gateway");
  assert.equal(classifyRole(stdio("C:\\Users\\x\\AppData\\Local\\Programs\\App\\srv.exe")), "vendor");
  assert.equal(classifyRole(stdio("cmd", ["/c", "npx", "-y", "pkg"])), "server");
});

test("sameServer ignores the cmd /c wrapper and executable extensions", () => {
  assert.equal(sameServer(stdio("cmd", ["/c", "npx", "-y", "a"]), stdio("npx", ["-y", "a"])), true);
  assert.equal(sameServer(stdio("C:\\bin\\gitnexus.cmd", ["mcp"]), stdio("/usr/bin/gitnexus", ["mcp"])), true);
  assert.equal(sameServer(stdio("cmd", ["/c", "npx", "-y", "a"]), stdio("npx", ["-y", "b"])), false);
});

test("gitBinSearchDirs adds Windows install dirs for the ';' delimiter", () => {
  const dirs = gitBinSearchDirs("C:\\a;C:\\b", "C:\\Users\\x", ";");
  assert.ok(dirs.includes("C:\\a"));
  assert.ok(dirs.includes("C:\\Program Files\\Git\\cmd"));
  assert.ok(dirs.includes("C:\\Users\\x\\.local\\bin"));
  assert.ok(!dirs.includes("/usr/bin"));
});
