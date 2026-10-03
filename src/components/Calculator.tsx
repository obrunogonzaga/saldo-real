"use client";

import { useEffect, useRef, useState } from "react";
import channels from "@/data/channels.json";
import type { ChannelId } from "@/types/channels";
import {
  calculatePricing,
  formatBRL,
  type CalcMode,
  type PricingBreakdown,
} from "@/lib/pricing";
import { parseBRNumber } from "@/lib/numbers";
import { DRAFT_KEY, type SimulationDraft } from "@/lib/simulation-draft";
import { classifyOrigin, recordBrowserEvent } from "@/lib/operational-telemetry";
import {
  isRuleCurrent,
  mlDropOffRule,
  resolveFixedFee,
  type TariffMode,
} from "@/lib/tariffs";

type FieldName =
  | "productCost"
  | "packaging"
  | "sellerShipping"
  | "desiredMargin"
  | "taxPercent"
  | "commissionPercent"
  | "fixedFee"
  | "salePrice";
const fields: Record<FieldName, string> = {
  productCost: "Custo do produto (R$)",
  packaging: "Embalagem (R$)",
  sellerShipping: "Frete pago por você (R$)",
  desiredMargin: "Margem desejada (%)",
  taxPercent: "Imposto (%)",
  commissionPercent: "Comissão do canal (%)",
  fixedFee: "Taxa fixa por unidade (R$)",
  salePrice: "Preço de venda (R$)",
};
const initialValues: Record<FieldName, string> = {
  productCost: "",
  packaging: "0",
  sellerShipping: "0",
  desiredMargin: "20",
  taxPercent: "",
  commissionPercent: "",
  fixedFee: "",
  salePrice: "",
};
export interface SimulationSnapshot {
  channel: string;
  mode: CalcMode;
  breakdown: PricingBreakdown;
  createdAt: string;
  assumptions: string[];
}

export function Calculator({
  allowAccount = false,
  accountMode = false,
}: {
  allowAccount?: boolean;
  accountMode?: boolean;
}) {
  const [channel, setChannel] = useState<ChannelId>("mercado_livre");
  const [mode, setMode] = useState<CalcMode>("margin_to_price");
  const [values, setValues] = useState(initialValues);
  const [excludeTax, setExcludeTax] = useState(false);
  const [snapshot, setSnapshot] = useState<SimulationSnapshot | null>(null);
  const [draft, setDraft] = useState<SimulationDraft | null>(null);
  const [errors, setErrors] = useState<Partial<Record<FieldName, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [example, setExample] = useState(false);
  const [tariffMode, setTariffMode] = useState<TariffMode>("manual");
  const [confirmedDropOff, setConfirmedDropOff] = useState(false);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const revision = useRef(0);
  useEffect(() => {
    if (snapshot) resultRef.current?.focus();
  }, [snapshot]);
  useEffect(() => {
    if (!accountMode) {
      recordBrowserEvent("origin", classifyOrigin(document.referrer, window.location.origin));
    }
  }, [accountMode]);

  function invalidate() {
    revision.current++;
    setSnapshot(null);
    setDraft(null);
    setError(null);
    setErrors({});
  }
  function update(name: FieldName, value: string) {
    invalidate();
    setValues((current) => ({ ...current, [name]: value }));
  }
  function loadExample() {
    invalidate();
    setExample(true);
    setTariffMode("manual");
    setConfirmedDropOff(false);
    setMode("margin_to_price");
    setExcludeTax(false);
    setValues({
      productCost: "50",
      packaging: "3",
      sellerShipping: "0",
      desiredMargin: "20",
      taxPercent: "6",
      commissionPercent: "16",
      fixedFee: "6",
      salePrice: "100",
    });
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setErrors({});
    setSnapshot(null);
    setDraft(null);
    const nextErrors: Partial<Record<FieldName, string>> = {};
    const parsed = {} as Record<FieldName, number>;
    for (const name of Object.keys(fields) as FieldName[]) {
      if (
        (name === "salePrice" && mode !== "price_to_profit") ||
        (name === "desiredMargin" && mode !== "margin_to_price") ||
        (name === "taxPercent" && excludeTax) ||
        (name === "fixedFee" && tariffMode === "ml_drop_off")
      ) {
        parsed[name] = 0;
        continue;
      }
      try {
        parsed[name] = parseBRNumber(values[name], fields[name]);
      } catch (e) {
        nextErrors[name] =
          e instanceof Error ? e.message : "Revise este valor.";
      }
    }
    if (Object.keys(nextErrors).length) {
      setErrors(nextErrors);
      setError("Revise os campos indicados. Nenhum cálculo foi concluído.");
      requestAnimationFrame(() =>
        document.getElementById(Object.keys(nextErrors)[0])?.focus(),
      );
      return;
    }
    try {
      const tariff = resolveFixedFee(
        tariffMode,
        parsed.fixedFee,
        confirmedDropOff,
      );
      const input = {
        ...parsed,
        fixedFee: tariff.amount,
        desiredMarginPercent: parsed.desiredMargin,
        mode,
      };
      const breakdown = calculatePricing(input);
      setDraft({
        version: 1,
        channelId: channel,
        input,
        tariffMode,
        confirmedDropOff,
        excludeTax,
      });
      setSnapshot({
        channel: channels[channel].label,
        mode,
        breakdown,
        createdAt: new Date().toISOString(),
        assumptions: [
          tariffMode === "manual"
            ? "Taxas informadas manualmente pelo usuário. Versão: manual-v1."
            : `Custo fixo zero para ME2 Drop Off confirmado pelo usuário. Versão: ${tariff.ruleId}. Comissão e frete informados manualmente.`,
          ...(tariffMode === "ml_drop_off"
            ? [
                `Fonte: ${mlDropOffRule.source}`,
                `Vigência desde ${mlDropOffRule.effectiveFrom}; conferência ${mlDropOffRule.checkedAt}; revisão até ${mlDropOffRule.reviewBy}.`,
              ]
            : []),
          `Comissão: ${parsed.commissionPercent}%. Imposto: ${parsed.taxPercent}%.`,
          ...(mode === "margin_to_price"
            ? [`Margem alvo sobre a venda: ${parsed.desiredMargin}%.`]
            : []),
          excludeTax
            ? "Impostos não incluídos por escolha do usuário."
            : "Alíquota informada pelo usuário; não constitui apuração fiscal.",
          "Uma unidade por venda. Despesas fixas, anúncios e devoluções não informados não estão incluídos.",
          ...(example
            ? [
                "Simulação iniciada com exemplo fictício; revise os valores antes de usar.",
              ]
            : []),
        ],
      });
      recordBrowserEvent("calculation", "internal");
    } catch (e) {
      recordBrowserEvent("calculation_error", "internal");
      setError(
        e instanceof Error
          ? e.message
          : "Não foi possível calcular. Revise os valores.",
      );
      requestAnimationFrame(() => errorRef.current?.focus());
    }
  }

  function continueInAccount() {
    if (!draft || !snapshot) return;
    try {
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
      window.location.assign(accountMode ? "/app" : "/cadastro");
    } catch {
      setError(
        "Não foi possível guardar o rascunho nesta aba. Verifique o armazenamento do navegador e tente novamente.",
      );
    }
  }

  async function exportPdf() {
    if (!snapshot) return;
    const currentRevision = revision.current;
    setExporting(true);
    setError(null);
    try {
      const { downloadBreakdownPdf } = await import("@/lib/pdf");
      if (currentRevision === revision.current) downloadBreakdownPdf(snapshot);
    } catch {
      setError(
        "Não foi possível gerar o PDF. Seu resultado continua disponível; tente novamente.",
      );
    } finally {
      setExporting(false);
    }
  }

  function field(name: FieldName, hint?: string) {
    return (
      <div className="field">
        <label htmlFor={name}>{fields[name]}</label>
        <input
          id={name}
          name={name}
          inputMode="decimal"
          autoComplete="off"
          value={values[name]}
          onChange={(event) => update(name, event.target.value)}
          aria-invalid={Boolean(errors[name])}
          aria-describedby={
            errors[name] ? `${name}-error` : hint ? `${name}-hint` : undefined
          }
          placeholder={name === "productCost" ? "Ex.: 50,00" : undefined}
        />
        {hint && (
          <p className="field-hint" id={`${name}-hint`}>
            {hint}
          </p>
        )}
        {errors[name] && (
          <p className="field-error" id={`${name}-error`}>
            {errors[name]}
          </p>
        )}
      </div>
    );
  }
  const b = snapshot?.breakdown;
  return (
    <div className="calculator-layout">
      <form className="calculator-form" onSubmit={submit} noValidate>
        <fieldset className="mode-switch">
          <legend className="sr-only">O que você quer calcular?</legend>
          {(
            [
              ["margin_to_price", "Encontrar meu preço"],
              ["price_to_profit", "Conferir minha margem"],
            ] as const
          ).map(([value, label]) => (
            <label key={value} className={mode === value ? "selected" : ""}>
              <input
                type="radio"
                name="mode"
                checked={mode === value}
                onChange={() => {
                  invalidate();
                  setMode(value);
                }}
              />
              {label}
            </label>
          ))}
        </fieldset>
        <div className="field channel-field">
          <label htmlFor="channel">Onde você vende?</label>
          <select
            id="channel"
            value={channel}
            onChange={(event) => {
              invalidate();
              setChannel(event.target.value as ChannelId);
              setTariffMode("manual");
              setConfirmedDropOff(false);
            }}
          >
            {(Object.entries(channels) as [ChannelId, { label: string }][]).map(
              ([id, c]) => (
                <option key={id} value={id}>
                  {c.label}
                </option>
              ),
            )}
          </select>
          <p className="field-hint">
            Comissão e frete são informados por você. Os valores são preservados
            ao trocar de canal; revise-os.
          </p>
        </div>
        {channel === "mercado_livre" && (
          <div className="tariff-box">
            <label htmlFor="tariff-mode">Como definir o custo fixo?</label>
            <select
              id="tariff-mode"
              value={tariffMode}
              onChange={(e) => {
                invalidate();
                setTariffMode(e.target.value as TariffMode);
                setConfirmedDropOff(false);
              }}
            >
              <option value="manual">Informar manualmente</option>
              <option value="ml_drop_off">
                Regra verificada: ME2 Drop Off
              </option>
            </select>
            {tariffMode === "ml_drop_off" ? (
              <>
                <p>
                  <strong>Custo fixo R$ 0,00.</strong> Só para anúncios com
                  Mercado Envios ME2 Drop Off (envio em agência), sem Flex.
                  Comissão da categoria, frete e imposto continuam manuais.
                </p>
                <p>
                  Vigente desde 02/03/2026 · conferida em 22/09/2026 · revisar
                  até 29/09/2026.{" "}
                  <a
                    href={mlDropOffRule.source}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Consultar fonte oficial
                  </a>
                  .
                </p>
                <label className="checkbox-field">
                  <input
                    type="checkbox"
                    checked={confirmedDropOff}
                    onChange={(e) => {
                      invalidate();
                      setConfirmedDropOff(e.target.checked);
                    }}
                  />
                  <span>
                    Conferi no anúncio: a logística é ME2 Drop Off, sem Flex ou
                    combinação de logísticas.
                  </span>
                </label>
                {!isRuleCurrent() && (
                  <p className="field-error">
                    Regra fora da janela de revisão. Selecione o modo manual.
                  </p>
                )}
              </>
            ) : (
              <p>
                Use o custo fixo da sua conta. Flex, envio próprio e
                configurações não cobertas exigem conferência manual. Seus
                valores manuais ficam preservados ao testar a regra.
              </p>
            )}
          </div>
        )}
        <div className="form-section-heading">
          <h3>Seus custos, por unidade</h3>
          <button type="button" className="text-button" onClick={loadExample}>
            Usar exemplo fictício
          </button>
        </div>
        {example && (
          <p className="example-notice">
            Exemplo fictício carregado. As taxas abaixo são ilustrativas, não
            tarifas oficiais.
          </p>
        )}
        <div className="fields-grid">
          {field("productCost")}
          {field(
            mode === "margin_to_price" ? "desiredMargin" : "salePrice",
            mode === "margin_to_price"
              ? "Percentual que deve sobrar sobre a venda."
              : undefined,
          )}
          {field("packaging")}
          {field(
            "sellerShipping",
            "Informe a parcela paga por você, por unidade.",
          )}
        </div>
        <h3 className="form-subtitle">Taxas da sua operação</h3>
        <div className="fields-grid">
          {field(
            "commissionPercent",
            "Confirme o percentual da categoria e do anúncio.",
          )}
          {tariffMode === "manual" ? (
            field("fixedFee")
          ) : (
            <div className="fixed-rule-value">
              <span>Custo fixo pela regra</span>
              <strong>R$ 0,00</strong>
            </div>
          )}
          {!excludeTax &&
            field(
              "taxPercent",
              "Informe sua alíquota ou confirme abaixo a exclusão.",
            )}
        </div>
        <label className="checkbox-field">
          <input
            type="checkbox"
            checked={excludeTax}
            onChange={(e) => {
              invalidate();
              setExcludeTax(e.target.checked);
            }}
          />
          <span>
            Simular sem impostos. Entendo que eles não estarão incluídos.
          </span>
        </label>
        {error && (
          <p className="error-banner" role="alert" tabIndex={-1} ref={errorRef}>
            {error}
          </p>
        )}
        <button type="submit" className="button primary calculate-button">
          {mode === "margin_to_price"
            ? "Calcular preço sugerido"
            : "Calcular contribuição"}
          <span aria-hidden="true">↗</span>
        </button>
        <p className="form-footnote">
          Nenhum dado é enviado a um marketplace. Uma unidade por venda.
        </p>
      </form>
      <aside className="result-panel" aria-label="Resultado da simulação">
        <div
          ref={resultRef}
          tabIndex={-1}
          className="result-content"
          aria-live="polite"
        >
          {snapshot && b ? (
            <>
              <div className="result-topline">
                <span>Simulação pronta</span>
                <span>{snapshot.channel}</span>
              </div>
              <h3>
                {snapshot.mode === "margin_to_price"
                  ? "Seu preço sugerido"
                  : "Contribuição por unidade"}
              </h3>
              <p
                className={`result-number ${b.netProfit < 0 ? "negative" : ""}`}
              >
                {formatBRL(
                  snapshot.mode === "margin_to_price"
                    ? b.suggestedPrice
                    : b.netProfit,
                )}
              </p>
              <p className="result-margin">
                {b.netProfit < 0
                  ? "A venda não cobre os custos informados."
                  : `${formatBRL(b.netProfit)} de contribuição por unidade.`}{" "}
                <strong>
                  {b.profitPercent.toLocaleString("pt-BR")}% da venda
                </strong>
              </p>
              <dl className="breakdown">
                <div>
                  <dt>Preço de venda</dt>
                  <dd>{formatBRL(b.suggestedPrice)}</dd>
                </div>
                {(
                  [
                    ["Produto", b.productCost],
                    ["Embalagem", b.packaging],
                    ["Frete", b.sellerShipping],
                    ["Comissão", b.commission],
                    ["Taxa fixa", b.fixedFee],
                    ["Imposto", b.tax],
                  ] as [string, number][]
                ).map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>− {formatBRL(value)}</dd>
                  </div>
                ))}
                <div
                  className={`breakdown-total ${b.netProfit < 0 ? "negative" : ""}`}
                >
                  <dt>Contribuição estimada</dt>
                  <dd>{formatBRL(b.netProfit)}</dd>
                </div>
              </dl>
              <details className="assumptions">
                <summary>Premissas desta simulação</summary>
                <ul>
                  {snapshot.assumptions.map((a) => (
                    <li key={a}>{a}</li>
                  ))}
                </ul>
              </details>
              <button
                type="button"
                className="button secondary export-button"
                disabled={exporting}
                onClick={exportPdf}
              >
                {exporting ? "Gerando PDF…" : "Baixar simulação em PDF"}
              </button>
              {allowAccount && (
                <button
                  type="button"
                  className="button primary save-account-button"
                  onClick={continueInAccount}
                >
                  {accountMode
                    ? "Continuar e salvar na conta"
                    : "Criar conta e guardar simulação"}
                </button>
              )}
              <p className="result-caution">
                Contribuição estimada não é lucro líquido. Considere também os
                custos que não entraram nesta conta.
              </p>
            </>
          ) : (
            <div className="result-empty">
              <span className="empty-symbol" aria-hidden="true">
                =
              </span>
              <h3>
                Quanto sobra
                <br />
                em cada venda?
              </h3>
              <p>
                Preencha os custos ao lado. Seu preço e o detalhamento aparecem
                aqui.
              </p>
              <div className="empty-checks">
                <span>Preço sugerido</span>
                <span>Contribuição por unidade</span>
                <span>Cada custo discriminado</span>
              </div>
              <p className="empty-tip">
                Não sabe por onde começar?
                <br />
                Use o exemplo fictício para explorar.
              </p>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
