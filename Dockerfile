FROM node:22-alpine
WORKDIR /app
COPY server.js clinico.js prontuario.js repasse.js hospitais.js documentos.js pdf.js ia.js contratacao.js seed.js pgmini.js schema.sql ./
COPY public ./public
COPY assets ./assets
EXPOSE 8080
CMD ["node","server.js"]
