FROM postgres:16-alpine
RUN apk add --no-cache openssl curl tzdata
COPY backup/backup.sh backup/restaurar.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/backup.sh /usr/local/bin/restaurar.sh
ENTRYPOINT ["backup.sh"]
CMD ["agendado"]
