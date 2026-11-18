FROM node:22-alpine
WORKDIR /app
COPY monitor/server.js monitor/index.html ./
RUN mkdir -p /dados && chown node:node /dados
USER node
ENV MONITOR_DADOS=/dados
EXPOSE 8090
CMD ["node", "server.js"]
