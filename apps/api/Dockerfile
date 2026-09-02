# WMS API — multi-stage build
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN npm ci --no-audit --no-fund --workspace=packages/shared --workspace=apps/api
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN npm run build -w packages/shared \
 && npm run build -w apps/api

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache wget
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/prisma ./apps/api/prisma
COPY --from=build /app/apps/api/prisma.config.ts ./apps/api/prisma.config.ts
COPY apps/api/docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh && addgroup -S wms && adduser -S wms -G wms && mkdir -p /data/uploads && chown -R wms:wms /data /app
USER wms
WORKDIR /app/apps/api
EXPOSE 4000
ENTRYPOINT ["/docker-entrypoint.sh"]
