# Issue #15 — operação do piloto

## Evidência desta branch

Migração `0010_operations.sql`: funil a partir dos registros do servidor (cadastro verificado, simulação salva, produto, importação/exportação CSV, recálculo, checkout, pagamento, renovação e cancelamento). Origem e cálculo são contagens anônimas enviadas pelo navegador com categorias fechadas. Não há identidade de visitante, URL de referência, entrada de cálculo, custo de produto, e-mail ou payload de gateway na telemetria. Contagens anônimas representam eventos recebidos, não usuários únicos; podem ser bloqueadas pelo navegador ou infladas por requisições forjadas. O histórico financeiro do funil é estável: eventos de confirmação (`payment_confirmed` e `renewal_confirmed`) registram a primeira confirmação válida por `payment_id` considerando a menor data comprovada disponível entre eventos de pagamento e `paid_at` no ciclo inicial (`LEAST`), e são preservados independentemente do estado atual da cobrança (como reembolso ou chargeback); sem timestamp de confirmação, nenhum evento é emitido. Os demais eventos do funil derivados de tabelas do aplicativo ainda refletem o estado disponível e permanecem mutáveis, não preservando toda transição histórica.

O cadastro verificado passa a ter horário próprio e único após a migração. Para contas já verificadas, a carga inicial usa `user.updatedAt` como aproximação histórica; não tratar esse horário como o momento exato da verificação.

O relatório financeiro é montado no servidor a partir de `billing_payment_cycle` (chave única por cobrança), `billing_order` e eventos financeiros deduplicados. `gross_confirmed_cents` inclui o valor bruto de cobranças inicialmente confirmadas; `reversed_cents` identifica as que hoje estão reembolsadas ou em chargeback; `currently_confirmed_cents` mostra as ainda confirmadas. `provider_received_cents` soma cobranças com `PAYMENT_RECEIVED` conciliado, **não** comprova depósito bancário nem saldo disponível. Os fluxos são `card_initial`, `card_recurring` e `pix_manual`. O relatório imprime `APP_ENV` e `ASAAS_ENV`; dados de Sandbox nunca são pagantes ou MRR real. O recorte `--since` usa a data do primeiro evento financeiro confirmado disponível e o fuso do banco; não é um livro contábil nem mede taxas, impostos ou caixa líquido.

## Consulta autorizada

Provisionar o papel PostgreSQL `liquido_ops_readonly` **somente leitura**, com acesso mínimo à view `operational_funnel_event`, às tabelas de cobrança, falhas e auditoria, e apenas às colunas `id`/`emailVerified` de `user` e `user_id`/`plan`/`expires_at` de `account_entitlement`. O comando exige essa credencial e abre uma transação `READ ONLY`; não há endpoint administrativo público. A posse da credencial define o operador autorizado; manter a concessão/revogação e o acesso ao host no gerenciador operacional.

Criar o papel com `CREATE ROLE liquido_ops_readonly LOGIN NOINHERIT;`, definir a senha interativamente com `\password liquido_ops_readonly` no `psql` e guardar uma cópia em `deploy/pilot/secrets/ops_postgres_password` **apenas no VPS**, fora do Git. O arquivo deve seguir as permissões de bind mount descritas em `deploy/pilot/backup/README.md`. Após provisionar a credencial, conceder somente:

```sql
GRANT CONNECT ON DATABASE liquido TO liquido_ops_readonly;
GRANT USAGE ON SCHEMA public TO liquido_ops_readonly;
GRANT SELECT ON operational_funnel_event, billing_payment_cycle, billing_order,
  billing_payment_event, access_change_audit, operational_failure_event
  TO liquido_ops_readonly;
GRANT SELECT (id, "emailVerified") ON "user" TO liquido_ops_readonly;
GRANT SELECT (user_id, plan, expires_at) ON account_entitlement TO liquido_ops_readonly;
```

Não conceder `INSERT`, `UPDATE` ou `DELETE`; conferir que o papel não possui permissões herdadas mais amplas.

No VPS, com os três overlays do piloto e o SHA revisado em `.env`, executar na pasta `deploy/pilot`:

```sh
export COMPOSE_FILE=compose.yaml:compose.database.yaml:compose.accounts.yaml
docker compose --profile ops config --quiet
docker compose --profile ops build ops
TZ=America/Sao_Paulo date +%F
docker compose run --rm ops --since=AAAA-MM-DD
docker compose run --rm ops --since=AAAA-MM-DD --account-id=ID_INTERNO
docker compose run --rm ops --since=AAAA-MM-DD --check
```

`ops` é um contêiner de execução única. A imagem usa o target `build`, que contém `tsx` e o script do relatório. Ele recebe somente o segredo `pilot_ops_db_password`, monta a URL de leitura em memória e se conecta apenas à rede interna `database`; não recebe a senha principal do banco, os segredos de conta nem acesso ao proxy. A view exige a migração `0010_operations.sql`. O comando `run` exige a data inicial e preserva o código de saída do relatório. `APP_ENV=production` identifica a implantação do piloto; `ASAAS_ENV=unknown` na saída não confirma ambiente de cobrança. Não imprimir `docker compose config` completo nem o conteúdo do segredo.

`--check` retorna código 2 quando encontra falha de checkout, exceção de pagamento, mudança de acesso sem atribuição, falha de e-mail/webhook ou erro de cálculo no período. Código 1 indica falha da própria consulta. Agendar esse comando e enviar saída/código ao canal e responsável **a definir**; ainda não há entrega de alerta comprovada. O script `deploy/pilot/backup/run-ops-check.sh` orquestra essa verificação operacional junto com um teste HTTP interno em `web` (`http://127.0.0.1:3000`), validando a saúde interna do app e do banco; não prova funcionamento de TLS, DNS, Basic Auth, entrega SMTP nem conexão externa com gateways. Exigir monitoramento externo para indisponibilidade do banco, pois a gravação de falhas também pode falhar nesse caso. Não copiar a saída por conta para issues públicas.


Mudança manual de acesso, apenas após autorização e conferência do gateway, deve usar `set_operator_entitlement(id, plano, vencimento, operador, motivo)` em transação controlada. PRO exige vencimento futuro. O gatilho registra plano anterior/novo, vencimento anterior/novo, responsável e motivo. Alterações diretas sem contexto ficam explicitamente `unattributed` e geram sinal no relatório; restringir `UPDATE` direto com permissões de banco e revisar esses casos. Não usar essa função para substituir conciliação financeira.

## Reconciliação e incidente

1. Consultar o relatório global e, se houver identificação segura da conta, o relatório por ID interno. Separar pedido aberto/falho, ciclo pago, evento de pagamento e direito de acesso. Não inferir pagamento a partir do retorno do navegador.
2. Confirmar ambiente, conta, valor, método, checkout, cobrança e estado no Asaas correspondente. No Sandbox, `npm run billing:reconcile -- --order-id=UUID` gera prévia; `--apply` só após conferência. O script é limitado ao Sandbox e passa pelo mesmo processador deduplicado. Em Produção, procedimento e credenciais ainda não foram homologados; escalar sem mutação manual improvisada.
3. Em divergência de acesso, registrar responsável, motivo, prazo e evidência antes de qualquer correção. Repetir consulta após a operação. Eventos duplicados devem manter uma cobrança por `payment_id`; reembolso/chargeback removem o valor do total atualmente confirmado.
4. Para falha de webhook ou e-mail, preservar identificadores de correlação em canal privado, verificar resposta do provedor e tentativa de reenvio. Se banco ou app estiver indisponível, priorizar restauração do serviço, reprocessamento seguro e comparação de pedidos/ciclos com o provedor. Não publicar PII, tokens ou custos.

## Backup e restauração

`deploy/pilot/backup/backup.sh` informa conclusão e duração. `verify-restore.sh` restaura isoladamente, consulta tabelas centrais e informa duração do ensaio e idade do arquivo por `mtime`. Essa idade é só aproximação da perda potencial; cópia de arquivo pode alterar `mtime`. Duração do ensaio não equivale ao tempo para recuperar app, DNS, webhook e acesso do cliente. Guardar hora do último dado confirmado antes da falha, hora do último dump íntegro e hora da volta da jornada para medir RPO/RTO de um cenário representativo. Comparar com metas **somente após** o responsável defini-las.

Ensaios anteriores em 24/09/2026: dump local restrito e restauração descartável de 17 tabelas; segundo ensaio recuperou 1 conta e 1 produto fictício. São evidência de restauração local, não de cópia externa, execução automática observada ou recuperação do host. Pendente: destino externo, retenção, monitoramento do cron, primeira execução automática comprovada, ensaio após perda do host e metas RPO/RTO.

## Revisão de tarifas

Em 25/09/2026, a documentação oficial [Custos por vender](https://developers.mercadolivre.com.br/pt_br/comissao-por-vender) continuava descrevendo custo fixo zero para ME2 `drop_off` no Brasil e custo fixo para Flex abaixo do limite. O preset vigente em `src/lib/tariffs.ts` permanece restrito a esse componente; comissão, frete e impostos vêm do usuário. A fonte alerta que categoria, anúncio, logística e outros parâmetros mudam a cobrança efetiva. Não houve cotação autenticada da conta. Próxima revisão já configurada: 29/09/2026; após a data, o preset falha fechado.

Toda semana: conferir a fonte oficial e amostras autenticadas das categorias/logísticas reais; registrar data, fonte, escopo, resultado e responsável. Se a regra mudar, publicar nova versão com vigência, testes de fronteira e migração de cálculos futuros. Preservar `rule_version` e avaliações históricas, sem reescrever resultados antigos. Se não for possível conferir, manter modo manual e preset vencido bloqueado. Tarifas do gateway e custo efetivo de Pix dependem da conta/contrato e do primeiro extrato real; não entram no custo de produto nem neste preset.

## Pendências de decisão e operação

**Escolhas para o piloto restrito:** R2 já existente em `hostinger-backups/daily/liquido-pilot/`; 14 dias de cópia externa conforme a regra `daily/` documentada, a confirmar no bucket; Healthchecks.io com e-mail para `bruno@aifbr.com.br`; meta RPO de 24 horas e RTO de 8 horas. São **metas**, não resultados medidos nem garantias. Se o ensaio integral excedê-las, corrigir o processo ou rever a meta explicitamente. Manter cópias locais existentes até que a cópia externa, a restauração e a política de retenção sejam comprovadas. A matriz legal de retenção permanece na #40.

- [ ] Definir metas RPO/RTO, cenário de falha e responsável pela medição.
- [ ] Definir destino externo, retenção, agenda e monitoramento do backup.
- [ ] Definir canal, responsável e janela do alerta; comprovar entrega e resposta.
- [ ] Provisionar papel de leitura e segredos por ambiente; testar revogação.
- [ ] Homologar reconciliação, receita e falhas em ambiente autorizado sem chamar Sandbox de produção.
- [ ] Resolver QA/políticas da #6 e aceites comerciais/operacionais da #40 antes do fechamento completo.
