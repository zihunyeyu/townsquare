/**
 * Copyright banner and license CLI.
 *
 * REQUIRED BY LICENSE (GPLv3 with Section 7 additional terms, see
 * README.md "法律声明与下游告示要求"): the startup banner, the
 * --license / --version commands and all author attribution must be
 * preserved in any distribution or fork. Do not remove or alter this file.
 */
const { version } = require("../package.json");

const BANNER = `
================================================================
  钟楼谜团魔典 townsquare-server v${version}
  Copyright (C) 2020-2023 bra1n (townsquare, GPLv3)
  Copyright (C) 2026 limpy01 (汉化与功能增强, GPLv3 附加条款)
  Copyright (C) 2026 zihunyeyu (自建后端与 Docker 部署)

  This program is free software licensed under GPLv3 with
  Section 7 additional terms. It comes with ABSOLUTELY NO
  WARRANTY. Run with --license for the full notice.

  本项目不以任何方式隶属于 The Pandemonium Institute。
================================================================
`;

const LICENSE_NOTICE = `
钟楼谜团魔典 townsquare-server v${version}

协议: GNU General Public License v3.0，附带 GPLv3 第 7 条允许的
      附加条款（署名保留要求）。完整协议文本见仓库 LICENSE 文件，
      附加条款见 README.md「法律声明与下游告示要求」。

作者署名（依据附加条款必须保留）:
  - bra1n       原版 townsquare 前端 (https://github.com/bra1n/townsquare)
  - limpy01     中文化与功能增强 (https://github.com/limpy01/townsquare)
  - zihunyeyu   自建后端 server/ 与 Docker 部署
                (https://github.com/zihunyeyu/townsquare)

下游告示要求（分发或分叉时必须遵守）:
  1. 必须完整保留终端启动时的版权横幅（Banner）。
  2. 必须保留用于打印许可证详细信息的交互式命令或参数
     （即本 --license 命令与 --version 命令）。
  3. 不得移除用户界面（UI）中的任何作者署名信息。

This project is not affiliated with The Pandemonium Institute
in any way. Blood on the Clocktower is a trademark of
Steven Medway and The Pandemonium Institute.
`;

/** Print the required startup banner. */
function printBanner() {
  console.log(BANNER);
}

/**
 * Handle license-related CLI flags.
 * @param argv process.argv
 * @returns {boolean} true if a flag was handled and the process should exit
 */
function handleCliFlags(argv = process.argv) {
  const args = argv.slice(2);
  if (args.includes("--version") || args.includes("-v")) {
    console.log(`townsquare-server v${version}`);
    return true;
  }
  if (args.includes("--license") || args.includes("--licence")) {
    console.log(LICENSE_NOTICE);
    return true;
  }
  return false;
}

module.exports = { printBanner, handleCliFlags, BANNER, LICENSE_NOTICE };
