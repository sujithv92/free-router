FROM node:20-slim

WORKDIR /app

# Install first so a code-only change reuses the dependency layer.
COPY package.json ./
RUN npm install --omit=dev

COPY . /app

# Container platforms assign the port and inject it as PORT. SnapDeploy sets
# and locks PORT, and binds the container behind a proxy, so the app has to
# listen on every interface rather than the 127.0.0.1 default in config.json.
ENV FREE_ROUTER_HOST=0.0.0.0
ENV NODE_ENV=production
ENV PORT=8787

EXPOSE 8787

# The image is stateless except for discovered-free-models.json, so the health
# check only has to prove the process answers.
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
