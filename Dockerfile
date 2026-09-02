# One image, three entrypoints. The service is chosen by the compose command.
FROM node:22-alpine AS base
WORKDIR /app
ENV NODE_ENV=production

# Install workspace dependencies from the lockfile only.
COPY package.json package-lock.json ./
COPY mini-scheduler/master/package.json ./mini-scheduler/master/
COPY mini-scheduler/worker/package.json ./mini-scheduler/worker/
COPY mini-scheduler-ui/package.json ./mini-scheduler-ui/
RUN npm ci --omit=dev --workspace mini-scheduler-master --workspace mini-scheduler-worker

COPY mini-scheduler ./mini-scheduler

# Tasks run as this user, not as root.
USER node

FROM base AS master
EXPOSE 3000
CMD ["node", "mini-scheduler/master/master.js"]

FROM base AS worker
EXPOSE 4001
CMD ["node", "mini-scheduler/worker/worker.js"]
