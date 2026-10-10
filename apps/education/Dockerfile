# Plip for school.
#
# Build from the REPOSITORY ROOT, not from this directory: the learning event
# contract lives at contracts/learning-event.schema.json and both the bundle
# and the server import it, so it has to be in the build context.
#
#   docker build -t plip-school -f apps/education/Dockerfile .
#   docker run --env-file apps/education/.env -p 8080:8080 \
#     -v plip-data:/var/lib/plip -v /etc/plip:/etc/plip:ro plip-school
#
# The image mirrors the repository layout (/srv/apps/education, /srv/contracts)
# so the relative import of the contract resolves exactly as it does in a
# checkout. There is no database container: node:sqlite keeps one file, which
# is why the volume matters more than anything else here.
#
# Node 22.5+ for node:sqlite. Nothing here reaches the internet except your
# identity provider.

FROM node:24-alpine AS build
WORKDIR /srv/apps/education
COPY apps/education/package.json apps/education/package-lock.json ./
RUN npm ci
COPY contracts /srv/contracts
COPY apps/education ./
RUN npm run typecheck && npm run build

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /srv/apps/education

# The server itself has no dependencies: node: built-ins only. Nothing from
# node_modules is copied into the running image.
COPY --from=build /srv/contracts /srv/contracts
COPY --from=build /srv/apps/education/dist ./dist
COPY --from=build /srv/apps/education/server ./server
COPY --from=build /srv/apps/education/shared ./shared
COPY --from=build /srv/apps/education/package.json ./package.json

RUN mkdir -p /var/lib/plip && chown -R node:node /var/lib/plip
USER node
EXPOSE 8080

ENV PLIP_MODE=production \
    PLIP_HOST=0.0.0.0 \
    PLIP_PORT=8080 \
    PLIP_DATABASE=/var/lib/plip/plip.sqlite \
    PLIP_CATALOGUE=/etc/plip/catalogue.json

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PLIP_PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/serve.mjs"]
