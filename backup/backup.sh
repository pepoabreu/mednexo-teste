#!/bin/sh
# Backup criptografado do MedNexo com teste automático de restauração.
# Variáveis: PGHOST PGUSER PGDATABASE BACKUP_SENHA (obrigatória) BACKUP_DIR (/backups) BACKUP_DIAS (30) BACKUP_HORA (03, horário de Brasília)
# Cópia externa opcional (S3/Cloudflare R2): BACKUP_S3_URL (ex.: https://<conta>.r2.cloudflarestorage.com/<bucket>) BACKUP_S3_CHAVE BACKUP_S3_SEGREDO BACKUP_S3_REGIAO (auto)
set -u
DIR="${BACKUP_DIR:-/backups}"; DB="${PGDATABASE:-mednexo}"; TESTE="${DB}_restauracao_teste"; DIAS="${BACKUP_DIAS:-30}"
mkdir -p "$DIR"; chmod 700 "$DIR"
log() { echo "[backup $(date -u +%FT%TZ)] $*"; }
registra() { # status, arquivo, bytes, detalhe
  psql -q -v ON_ERROR_STOP=1 -d "$DB" -c "CREATE TABLE IF NOT EXISTS mednexo.backup_registro (id bigserial PRIMARY KEY, criado_em timestamptz NOT NULL DEFAULT now(), status text NOT NULL, arquivo text, bytes bigint, sha256 text, restauracao_ok boolean, copia_externa text, detalhe text)" \
    -c "INSERT INTO mednexo.backup_registro (status, arquivo, bytes, sha256, restauracao_ok, copia_externa, detalhe) VALUES ('$1', '$2', ${3:-0}, '${4:-}', ${5:-false}, '${6:-}', \$q\$${7:-}\$q\$)" >/dev/null 2>&1 || log "não consegui registrar no banco"
}
um_backup() {
  [ -n "${BACKUP_SENHA:-}" ] || { log "BACKUP_SENHA não definida: backup NÃO executado"; registra falha "" 0 "" false "" "BACKUP_SENHA ausente"; return 1; }
  ARQ="$DIR/mednexo-$(date -u +%Y%m%d-%H%M%S).dump.enc"
  log "gerando $ARQ"
  if ! pg_dump -Fc -Z 6 -d "$DB" | openssl enc -aes-256-cbc -pbkdf2 -iter 300000 -salt -pass env:BACKUP_SENHA -out "$ARQ.tmp"; then
    rm -f "$ARQ.tmp"; registra falha "" 0 "" false "" "pg_dump/openssl falhou"; return 1; fi
  mv "$ARQ.tmp" "$ARQ"; chmod 600 "$ARQ"; TAM=$(wc -c < "$ARQ"); SHA=$(sha256sum "$ARQ" | cut -d' ' -f1); echo "$SHA  $(basename "$ARQ")" > "$ARQ.sha256"
  # ---- teste de restauração: decifra, restaura num banco separado e confere tabelas e contagens
  RES=false; DET=""
  dropdb --if-exists "$TESTE" 2>/dev/null; createdb "$TESTE"
  if openssl enc -d -aes-256-cbc -pbkdf2 -iter 300000 -pass env:BACKUP_SENHA -in "$ARQ" | pg_restore -d "$TESTE" --exit-on-error 2>"$DIR/.restauracao.log"; then
    Q="SELECT (SELECT count(*) FROM pg_tables WHERE schemaname='mednexo')||'|'||(SELECT count(*) FROM mednexo.organizacao)||'|'||(SELECT count(*) FROM mednexo.paciente)||'|'||(SELECT count(*) FROM mednexo.auditoria_evento)"
    A=$(psql -At -d "$DB" -c "$Q"); B=$(psql -At -d "$TESTE" -c "$Q")
    T1=$(echo "$A" | cut -d'|' -f1); T2=$(echo "$B" | cut -d'|' -f1)
    if [ "$T1" = "$T2" ] && [ "$(echo "$B" | cut -d'|' -f2)" -gt 0 ]; then RES=true; DET="tabelas/organizações/pacientes/auditoria: origem $A, restaurado $B"
    else DET="divergência: origem $A, restaurado $B"; fi
  else DET="pg_restore falhou: $(tail -c 300 "$DIR/.restauracao.log")"; fi
  dropdb --if-exists "$TESTE" 2>/dev/null
  # ---- cópia externa (opcional)
  EXT=""
  if [ -n "${BACKUP_S3_URL:-}" ]; then
    if curl -sf --aws-sigv4 "aws:amz:${BACKUP_S3_REGIAO:-auto}:s3" --user "${BACKUP_S3_CHAVE}:${BACKUP_S3_SEGREDO}" -T "$ARQ" "${BACKUP_S3_URL%/}/$(basename "$ARQ")" -o /dev/null; then EXT="ok"; else EXT="falhou"; fi
  fi
  # ---- retenção local
  find "$DIR" -name 'mednexo-*.dump.enc*' -mtime +"$DIAS" -delete
  ST=ok; [ "$RES" = true ] || ST=falha_restauracao
  registra "$ST" "$(basename "$ARQ")" "$TAM" "$SHA" "$RES" "$EXT" "$DET"
  log "$ST · $TAM bytes · restauração=$RES · externa=${EXT:-desligada} · $DET"
}
case "${1:-agendado}" in
  agora) um_backup ;;
  agendado)
    until pg_isready -q; do sleep 3; done; sleep 20
    # backup na subida se o último tiver mais de 20h
    U=$(psql -At -d "$DB" -c "SELECT coalesce(extract(epoch FROM now()-max(criado_em))::int, 999999) FROM mednexo.backup_registro WHERE status='ok'" 2>/dev/null || echo 999999)
    [ "${U:-999999}" -gt 72000 ] && um_backup
    while true; do
      H=$(TZ=America/Sao_Paulo date +%H); M=$(date +%M)
      if [ "$H" = "${BACKUP_HORA:-03}" ] && [ "$M" = "00" ]; then um_backup; sleep 61; fi
      sleep 30
    done ;;
esac
