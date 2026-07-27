# Project Provenance

## Upstream Origin
This project is a fork of the original work by **[bra1n]**, originally licensed under the GNU General Public License v3.0. 
* **Original Repository:** [https://github.com/bra1n/townsquare]
* **License:** GNU General Public License v3.0

## Modifications & Overhauls
* **2026:** All JSON asset architectures, translation mappings, and rule databases inside this repository have been completely overhauled and are copyrighted by limpy01 (2026). These modifications are licensed under the GNU General Public License v3.0 in accordance with the upstream license.

## Downstream Modifications (zihunyeyu fork)
* **2026:** Added a protocol-compatible self-hosted backend (`server/`), Docker packaging (`Dockerfile*`, `docker-compose*.yml`, `docker/`), and runtime-configurable backend endpoints (`src/config.js`) by [zihunyeyu](https://github.com/zihunyeyu/townsquare). These additions are licensed under GPLv3 with the same Section 7 additional terms; the startup banner, the `--license`/`--version` commands, and all author attribution (bra1n, limpy01, zihunyeyu) must be preserved in any distribution.