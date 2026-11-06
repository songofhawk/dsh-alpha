import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { randomBytes } from "node:crypto";
import { hashPassword, validateAccount } from "../src/lib/account-login.mjs";

export async function configureLogin() {
  if (!process.stdin.isTTY) throw new Error("请在交互终端运行 dsh-alpha login-setup（密码不会显示或写入命令历史）");
  const dataDir = process.env.DSH_ALPHA_DATA_DIR || path.join(process.env.DSH_HOME || path.join(os.homedir(), ".dsh"), "storages", "dsh-alpha");
  const file = process.env.DSH_ALPHA_LOGIN_FILE || path.join(dataDir, "login.json");
  let hidden = false;
  const output = new Writable({ write(chunk, _encoding, callback) { if (!hidden) process.stdout.write(chunk); callback(); } });
  output.isTTY = true;
  output.columns = process.stdout.columns || 80;
  const prompt = createInterface({ input: process.stdin, output, terminal: true });
  const ask = async (label, secret = false) => {
    process.stdout.write(label);
    hidden = secret;
    try { return await prompt.question(""); }
    finally { hidden = false; if (secret) process.stdout.write("\n"); }
  };
  try {
    if (fs.existsSync(file) && (await ask("已有账号；替换后旧会话将在重启后失效。继续？[y/N] ")).toLowerCase() !== "y") return;
    const username = (await ask("用户名（留空使用 admin）：")).trim() || "admin";
    const password = await ask("密码（至少 12 字节）：", true);
    if (password !== await ask("再次输入密码：", true)) throw new Error("两次密码不一致，未修改配置");
    const account = validateAccount({ version: 1, username, passwordHash: await hashPassword(password) });
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(account, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      fs.renameSync(temporary, file);
    } finally { fs.rmSync(temporary, { force: true }); }
    process.stdout.write(`登录账号已保存到 ${file}。请重启 DSH Web 使其生效。\n`);
  } finally { prompt.close(); }
}
