# Banco e backup do piloto restrito

Este overlay prepara um PostgreSQL 18 próprio do piloto. Não abre porta para o host. A rede `database` é interna; somente `web` também participa dela. O volume `pilot_postgres_data` contém os dados e **não deve ser removido** durante atualização. O cadastro permanece desativado até a ativação separada da aplicação.

## Preparação local no servidor

Na pasta `deploy/pilot`, criar o segredo fora do Git:

```sh
umask 077
mkdir -p secrets
chmod 700 secrets
(set -C; openssl rand -hex 32 > secrets/postgres_password)
chmod 644 secrets/postgres_password
docker compose -f compose.yaml -f compose.database.yaml config --quiet
```

Gerar o arquivo somente no provisionamento inicial; não substituí-lo depois que o banco tiver dados. O `set -C` impede sobrescrever um arquivo existente. O diretório `secrets` fica com modo `0700` no host. O arquivo fica com modo `0644` para que os processos sem privilégio dos contêineres o leiam: em Compose, segredos vindos de arquivo são montados por bind e não recebem remapeamento de permissões. O diretório privado do host impede outros usuários locais de alcançá-lo. O mesmo segredo é montado em `db` e `web`. O inicializador de `web` forma `DATABASE_URL` em memória. Não imprimir `docker compose config` integralmente nem passar a senha em argumentos.

Após a revisão e autorização da publicação, iniciar a stack com os dois arquivos Compose e confirmar que `db` está saudável antes das migrações. Usar sempre os dois arquivos nos comandos de operação desta stack. **Não** executar `down --volumes` nela.

## Backup diário

Agendar `backup/backup.sh` uma vez ao dia no cron do host, por exemplo às 03:15 no horário configurado do servidor:

```cron
15 3 * * * /caminho/da/stack/deploy/pilot/backup/backup.sh
```

O script grava `pg_dump` em formato customizado no diretório estável `/opt/stacks/liquido-pilot/backups`, fora das pastas de release, e publica o arquivo somente após o comando terminar. Ao concluir, informa a duração e o horário UTC do backup. Não remove backups automaticamente até haver uma política de retenção aprovada. O diretório privado e o segredo estão fora do Git e do contexto de build. Monitorar falhas do cron e espaço em disco. Estes backups ficam no **mesmo host** que o banco: eles não cobrem perda do VPS e não comprovam prontidão de backup externo. O agendamento acima é um exemplo, não uma configuração já ativa.

## Ensaio de restauração

Executar `backup/verify-restore.sh /opt/stacks/liquido-pilot/backups/liquido-YYYYMMDDTHHMMSSZ-PID.dump`. O script cria um projeto Compose exclusivo com banco em `tmpfs`, restaura o dump em `restore_test`, confere que há tabelas públicas e executa consultas nas tabelas de contas, simulações, catálogo e cobrança, sem imprimir linhas ou dados pessoais. Ele remove o projeto no final e não usa o serviço `db` nem a senha do piloto. A saída informa a duração do ensaio e a idade do arquivo no início da restauração, calculada pelo horário de modificação do arquivo. Essa idade é um **indicador** do RPO observado no ensaio; uma cópia que altera o horário de modificação pode torná-lo enganoso. A duração é uma medida do teste isolado, não um compromisso de RTO da aplicação. Guarde a data e o resultado do ensaio fora dos dados privados. Um resultado positivo comprova a restauração e as consultas descritas; não comprova todas as consultas da aplicação nem recuperação após perda do host.

## Cópia externa e monitoramento escolhidos para o piloto

Destino: bucket R2 existente `hostinger-backups`, prefixo `daily/liquido-pilot/`. O novo `run-daily.sh` executa o dump local, usa o helper existente `/usr/local/sbin/hostinger-backup-upload` e confere o conteúdo remoto com `rclone check --download`; só então envia sucesso ao Healthchecks.io. O arquivo local permanece mesmo se o upload falhar. O script não remove backups existentes. O plano de infraestrutura registra expiração de `daily/` após 14 dias, mas **a regra não foi verificada na configuração do bucket**; conferir privacidade e [lifecycle](https://developers.cloudflare.com/r2/buckets/object-lifecycles/) antes de ativar o cron novo. O R2 oferece [criptografia em trânsito e em repouso](https://developers.cloudflare.com/r2/reference/data-security/); o operador com a credencial do bucket ainda consegue ler os objetos.

Para ensaiar a cópia externa, usar `backup/verify-offsite-restore.sh liquido-YYYYMMDDTHHMMSSZ-PID`. Ele baixa o objeto do prefixo exclusivo para diretório temporário privado, chama o ensaio isolado e elimina somente a cópia temporária criada. Registra tempo de download e de download + validação do banco; ainda não mede a volta da aplicação, que deve entrar no RTO completo.

Criar duas verificações no Healthchecks.io, com notificações por e-mail para `bruno@aifbr.com.br` (contato já documentado no piloto): backup diário `15 3 * * *` UTC com 60 minutos de tolerância; consulta operacional horária `30 * * * *` UTC com 20 minutos de tolerância. Guardar cada URL de ping (segredo) em arquivos distintos no VPS, root-only, modo `0600`, sem colar em chat ou log:

```text
/etc/liquido-pilot/backup-healthcheck-url
/etc/liquido-pilot/ops-healthcheck-url
```

Depois de instalar os scripts revisados no release, configurar a credencial de leitura `ops` e verificar manualmente upload, leitura remota, restauração e recepção de um alerta de teste, trocar **somente** o cron do piloto para:

```cron
15 3 * * * root /caminho/da/stack/deploy/pilot/backup/run-daily.sh >> /opt/stacks/liquido-pilot/backup.log 2>&1
30 * * * * root /caminho/da/stack/deploy/pilot/backup/run-ops-check.sh >> /opt/stacks/liquido-pilot/ops-check.log 2>&1
```

Não substituir o cron atual antes de concluir os pré-requisitos: o backup local diário que já funciona deve continuar até a mudança ser testada. O `run-ops-check.sh` executa uma verificação HTTP interna no contêiner `web` (`http://127.0.0.1:3000`) e consulta os últimos 90 minutos de telemetria no banco; falha de serviço web, resposta não-2xx, timeout, webhook, e-mail, cálculo, acesso sem atribuição ou indisponibilidade do banco gera sinal de falha ao monitor. Essa verificação afere apenas a saúde interna da aplicação e do banco; não prova funcionamento de TLS, DNS, Basic Auth, entrega SMTP nem comunicação com gateways externos. Os pings enviam somente estado e horário, sem dumps, e-mails, valores de cálculo ou payloads.
