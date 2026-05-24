# Multi-stage build para otimizar tamanho da imagem
FROM node:18-alpine AS builder

WORKDIR /app

# Copie package files
COPY package*.json ./

# Instale dependências de build
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    cairo-dev \
    jpeg-dev \
    pango-dev \
    giflib-dev \
    pixman-dev

# Instale dependências
RUN npm ci --only=production

# ════════════════════════════════════════════════════════
# Stage 2: Runtime
FROM node:18-alpine

LABEL maintainer="DocFlow Team <dev@docflow.pro>"
LABEL description="DocFlow Pro v2.0 - Conversor PDF Robusto & Privado"
LABEL version="2.0.0"

WORKDIR /app

# Instale runtime dependencies
RUN apk add --no-cache \
    tini \
    cairo \
    jpeg \
    pango \
    giflib \
    pixman \
    dumb-init

# Copie dependências do builder
COPY --from=builder /app/node_modules ./node_modules

# Copie aplicação
COPY package*.json ./
COPY server.js ./
COPY index.html ./

# Crie diretórios necessários
RUN mkdir -p uploads outputs data logs temp && \
    chmod 755 uploads outputs data logs temp

# Crie utilizador não-root
RUN addgroup -g 1000 docflow && \
    adduser -D -u 1000 -G docflow docflow && \
    chown -R docflow:docflow /app

# Mude para utilizador não-root
USER docflow

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/api/health', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

# Use tini para manejar sinais
ENTRYPOINT ["/sbin/tini", "--"]

# Start application
CMD ["node", "server.js"]
