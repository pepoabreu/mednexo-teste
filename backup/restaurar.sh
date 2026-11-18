#!/bin/sh
# Restaura um backup cifrado num banco NOVO (nunca sobrescreve o banco em uso).
# Uso: BACKUP_SENHA=... ./restaurar.sh /backups/mednexo-AAAAMMDD-HHMMSS.dump.enc mednexo_restaurado
set -eu
ARQ="$1"; ALVO="${2:-mednexo_restaurado}"
[ -n "${BACKUP_SENHA:-}" ] || { echo "Defina BACKUP_SENHA"; exit 1; }
if [ -f "$ARQ.sha256" ]; then (cd "$(dirname "$ARQ")" && sha256sum -c "$(basename "$ARQ").sha256"); fi
createdb "$ALVO"
openssl enc -d -aes-256-cbc -pbkdf2 -iter 300000 -pass env:BACKUP_SENHA -in "$ARQ" | pg_restore -d "$ALVO" --exit-on-error
echo "Restaurado em $ALVO. Confira e, para colocar em produção, troque PGDATABASE do app para $ALVO."
