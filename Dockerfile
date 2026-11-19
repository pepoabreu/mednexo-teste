FROM node:22-alpine
WORKDIR /app
COPY server.js clinico.js prontuario.js repasse.js hospitais.js documentos.js pdf.js ia.js contratacao.js tele.js equipe.js asaas.js portal.js seguranca.js plataforma.js antivirus.js lgpd.js demo.js seed.js pgmini.js schema.sql ./
COPY public ./public
COPY assets ./assets
COPY vendor ./vendor
EXPOSE 8080
CMD ["node","server.js"]
