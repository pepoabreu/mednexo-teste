FROM node:22-alpine
WORKDIR /app
COPY server.js clinico.js prontuario.js seed.js pgmini.js schema.sql ./
COPY public ./public
EXPOSE 8080
CMD ["node","server.js"]
