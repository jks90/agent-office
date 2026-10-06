#!/usr/bin/env bash
# FT-58: instala Codebase-Memory MCP (DeusData, MIT; binario único con tree-sitter, local, sin root) en data/tools/bin.
# Idempotente: si ya está la versión pedida no hace nada. Uso: scripts/setup-code-index.sh [vX.Y.Z]
set -euo pipefail
VERSION="${1:-v0.11.0}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${AO_DATA_DIR:-$ROOT/data}/tools/bin"
BIN="$DEST/codebase-memory-mcp"
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) ASSET=linux-amd64-portable ;;
  Linux-aarch64|Linux-arm64) ASSET=linux-arm64-portable ;;
  Darwin-arm64) ASSET=darwin-arm64 ;;
  Darwin-x86_64) ASSET=darwin-amd64 ;;
  *) echo "Plataforma no soportada: $(uname -sm)" >&2; exit 1 ;;
esac
if [ -x "$BIN" ] && [ "$("$BIN" --version 2>/dev/null | awk '{print $NF}')" = "${VERSION#v}" ]; then echo "✓ codebase-memory-mcp ${VERSION} ya instalado en $BIN"; exit 0; fi
mkdir -p "$DEST"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
BASE="https://github.com/DeusData/codebase-memory-mcp/releases/download/${VERSION}"
echo "↓ ${BASE}/codebase-memory-mcp-${ASSET}.tar.gz"
curl -fsSL "${BASE}/codebase-memory-mcp-${ASSET}.tar.gz" -o "$TMP/cbm.tgz"
curl -fsSL "${BASE}/checksums.txt" -o "$TMP/sums.txt"
WANT="$(grep " codebase-memory-mcp-${ASSET}.tar.gz\$" "$TMP/sums.txt" | awk '{print $1}')"
GOT="$(sha256sum "$TMP/cbm.tgz" | awk '{print $1}')"
[ -n "$WANT" ] && [ "$WANT" = "$GOT" ] || { echo "✗ checksum no coincide" >&2; exit 1; }
tar -xzf "$TMP/cbm.tgz" -C "$TMP"
install -m 755 "$(find "$TMP" -type f -name 'codebase-memory-mcp*' ! -name '*.tgz' | head -1)" "$BIN"
"$BIN" --version
echo "✓ Instalado. Actívalo en Ajustes ▸ «Índice de código por símbolos» (FT-58)."
