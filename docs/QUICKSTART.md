# ⚡ DocFlow Pro — Guia de Início Rápido

Tenha o DocFlow Pro rodando em **5 minutos**.

## 📦 Opção 1: Local (Desenvolvimento)

### Pré-requisitos
```bash
Node.js ≥ 16   # Check: node --version
npm ≥ 8        # Check: npm --version
Git            # Check: git --version
```

### Instalação (2 minutos)
```bash
# 1. Clone
git clone https://github.com/docflow/docflow-pro.git
cd docflow-pro

# 2. Instale dependências
npm install

# 3. Copie configuração
cp .env.example .env

# 4. Inicie
npm run dev

# ✅ Pronto! Abra: http://localhost:3000
```

### Admin Padrão (1ª Execução)
```
Email:  admin@docflow.ao
Senha:  Admin@2026

⚠️ ALTERE IMEDIATAMENTE APÓS LOGIN!
```

### Teste a Conversão
```bash
# 1. Abra http://localhost:3000
# 2. Clique "Começar" ou arraste um PDF
# 3. Selecione "PDF → Word"
# 4. Clique converter
# 5. Veja o Smart Repair em ação! ✨
```

## 🐳 Opção 2: Docker (Recomendado)

### Pré-requisitos
```bash
Docker ≥ 20.10
Docker Compose ≥ 1.29
```

### Instalação (3 minutos)
```bash
# 1. Clone
git clone https://github.com/docflow/docflow-pro.git
cd docflow-pro

# 2. Build
docker build -t docflow-pro:latest .

# 3. Run
docker run -p 3000:3000 \
  -v docflow-data:/app/data \
  -v docflow-logs:/app/logs \
  docflow-pro:latest

# ✅ Abra: http://localhost:3000
```

### Docker Compose (Completo com Redis)
```bash
# 1. Clone
git clone https://github.com/docflow/docflow-pro.git
cd docflow-pro

# 2. Start
docker-compose up -d

# ✅ Serviços:
#  • DocFlow:    http://localhost:3000
#  • Redis:      localhost:6379
#  • Prometheus: http://localhost:9090 (opcional)
#  • Grafana:    http://localhost:3001 (opcional)

# 3. Ver logs
docker-compose logs -f docflow

# 4. Parar
docker-compose down
```

## ☁️ Opção 3: Produção (Ubuntu 20.04 + Nginx)

### Pré-requisitos
```bash
Ubuntu 20.04 LTS
Root ou sudo access
1 IP público
Domínio (recomendado)
```

### Instalação (5-10 minutos)

```bash
# 1. SSH no servidor
ssh ubuntu@seu.servidor.com

# 2. Update sistema
sudo apt update && sudo apt upgrade -y

# 3. Instale Node.js 16
curl -fsSL https://deb.nodesource.com/setup_16.x | sudo -E bash -
sudo apt install -y nodejs build-essential

# 4. Clone aplicação
cd /opt
sudo git clone https://github.com/docflow/docflow-pro.git
sudo chown -R $(whoami) docflow-pro
cd docflow-pro

# 5. Instale dependências
npm ci --only=production

# 6. Configure variáveis
nano .env
# Edite:
# NODE_ENV=production
# PORT=3000
# CORS_ORIGIN=https://seu.dominio.com

# 7. Crie systemd service
sudo tee /etc/systemd/system/docflow.service << 'EOF'
[Unit]
Description=DocFlow Pro v2.0
After=network.target

[Service]
Type=simple
User=nobody
WorkingDirectory=/opt/docflow-pro
ExecStart=/usr/bin/node /opt/docflow-pro/server.js
Restart=always
RestartSec=10
StandardOutput=append:/var/log/docflow.log
StandardError=append:/var/log/docflow.log
Environment="NODE_ENV=production"

[Install]
WantedBy=multi-user.target
EOF

# 8. Ative e inicie
sudo systemctl daemon-reload
sudo systemctl enable docflow
sudo systemctl start docflow

# 9. Verifique status
sudo systemctl status docflow

# 10. Configure Nginx (reverse proxy + SSL)
sudo apt install -y nginx certbot python3-certbot-nginx

# 11. Crie config Nginx
sudo tee /etc/nginx/sites-available/docflow << 'EOF'
server {
    listen 80;
    server_name seu.dominio.com www.seu.dominio.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name seu.dominio.com www.seu.dominio.com;
    
    ssl_certificate /etc/letsencrypt/live/seu.dominio.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/seu.dominio.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;
    
    client_max_body_size 200M;
    
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
EOF

# 12. Ative site
sudo ln -s /etc/nginx/sites-available/docflow /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t

# 13. SSL com Let's Encrypt
sudo certbot certonly --standalone -d seu.dominio.com -d www.seu.dominio.com

# 14. Inicie Nginx
sudo systemctl start nginx
sudo systemctl enable nginx

# ✅ Pronto! Aceda: https://seu.dominio.com
```

### Verificar Status
```bash
# Ver logs da aplicação
sudo tail -50 /var/log/docflow.log

# Ver status do serviço
sudo systemctl status docflow

# Reiniciar se necessário
sudo systemctl restart docflow

# Ver status Nginx
sudo systemctl status nginx
```

### Backup & Disaster Recovery
```bash
# Backup automático dos dados (cron)
sudo tee /opt/backup-docflow.sh << 'EOF'
#!/bin/bash
BACKUP_DIR="/opt/backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

mkdir -p $BACKUP_DIR
tar -czf $BACKUP_DIR/docflow_$TIMESTAMP.tar.gz /opt/docflow-pro/data/
find $BACKUP_DIR -name "docflow_*.tar.gz" -mtime +30 -delete

echo "✅ Backup completo: docflow_$TIMESTAMP.tar.gz"
EOF

chmod +x /opt/backup-docflow.sh
echo "0 2 * * * /opt/backup-docflow.sh" | sudo crontab -

# Restore de backup
tar -xzf /opt/backups/docflow_YYYYMMDD_HHMMSS.tar.gz -C /
sudo systemctl restart docflow
```

## 🔐 Checklist Segurança Pós-Deploy

### Imediatamente Após Instalação
```
[ ] Altere a senha do admin (admin@docflow.ao)
[ ] Configure CORS_ORIGIN com domínio correto
[ ] Ative HTTPS (Let's Encrypt)
[ ] Configure firewall:
    - Abra apenas portas 80, 443, 22
    - ssh com chave (desative password auth)
[ ] Desative root login via SSH
[ ] Instale fail2ban: sudo apt install fail2ban
```

### Backup & Disaster Recovery
```
[ ] Crie backup automático (cron diário)
[ ] Teste restore de backup
[ ] Guarde backup em local seguro (S3, outro servidor)
[ ] Plano de recuperação em caso de falha
```

### Monitoramento & Alertas
```
[ ] Configure alertas de disco cheio (90%+)
[ ] Alertas de CPU alta (80%+)
[ ] Alertas de memória (85%+)
[ ] Alertas de erro (logs)
[ ] Email de notificação
```

### SSL/TLS
```
[ ] Valide certificado: openssl s_client -connect seu.dominio.com:443
[ ] Configure auto-renew Let's Encrypt
    sudo systemctl enable certbot.timer
    sudo systemctl start certbot.timer
[ ] Teste renovação: sudo certbot renew --dry-run
```

## 📊 Verificar Performance

### Speed Test
```bash
# Teste de latência
curl -w "@curl-format.txt" -o /dev/null -s http://localhost:3000

# Template (salve como curl-format.txt):
# time_namelookup:  %{time_namelookup}s
# time_connect:     %{time_connect}s
# time_appconnect:  %{time_appconnect}s
# time_redirect:    %{time_redirect}s
# time_pretransfer: %{time_pretransfer}s
# time_starttransfer: %{time_starttransfer}s
# time_total:       %{time_total}s
```

### Load Test (Stress Test)
```bash
# Instale artillery
npm install -g artillery

# Teste
artillery quick -d 30 -r 10 http://seu.dominio.com/api/health

# Interpretação:
# r 10 = 10 requisições por segundo
# d 30 = durante 30 segundos
# Total = 300 requisições
```

## 🐛 Troubleshooting

### Problema: "Cannot find module pdf-lib"
```bash
# Solução:
rm -rf node_modules package-lock.json
npm install
npm run dev
```

### Problema: "Port 3000 already in use"
```bash
# Encontre o processo
lsof -i :3000

# Mate o processo
kill -9 <PID>

# Ou use outra porta
PORT=3001 npm run dev
```

### Problema: "ENOSPC: no space left on device"
```bash
# Disco cheio! Limpe:
df -h  # Ver uso
docker system prune  # Se usar Docker
rm -rf uploads/* temp/* outputs/*
```

### Problema: "Jest timeout exceeded"
```bash
# Aumente timeout nos testes
npm test -- --testTimeout=30000
```

### Problema: Ficheiros não são eliminados
```bash
# Verifique cron de limpeza
sudo journalctl -u docflow -f

# Ou force manualmente:
find uploads -mmin +60 -delete
find temp -mmin +60 -delete
find outputs -mmin +60 -delete
```

## 📈 Escalamento Futuro

### Quando migrar para Kubernetes?
```
Utilizadores: >1000
Requisições/s: >100
Ficheiros armazenados: >1000
Team size: >3 DevOps
```

### Passos para Kubernetes
```
1. Dockerizar completamente ✓ (já feito)
2. CI/CD pipeline (GitHub Actions / GitLab)
3. Helm charts para deployment
4. Service mesh (Istio)
5. Auto-scaling horizontal
6. Database replication (PostgreSQL)
7. Redis Cluster
8. Monitoring (Prometheus + Grafana)
```

## 📞 Support

### Recursos
- **Documentação**: https://docs.docflow.pro
- **Issues**: https://github.com/docflow/docflow-pro/issues
- **Email**: suporte@docflow.pro
- **Chat**: https://discord.gg/docflow

### Logs Úteis
```bash
# Aplicação
tail -100 /var/log/docflow.log

# Sistema
sudo journalctl -u docflow -f

# Nginx
sudo tail -100 /var/log/nginx/access.log
sudo tail -100 /var/log/nginx/error.log
```

---

**Bem-vindo ao DocFlow Pro!** 🚀

Dúvidas? Abra uma issue no GitHub!
