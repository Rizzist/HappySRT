// components/UpgradePlansModal.js
import { useEffect, useMemo, useState } from "react";
import styled, { keyframes } from "styled-components";
import { toast } from "sonner";
import { useAuth } from "../contexts/AuthContext"; // adjust path if needed

import PlansImport from "../shared/plans";
const Plans = (PlansImport && (PlansImport.default || PlansImport)) || {};
const { PLANS, PLAN_KEYS, formatBytes } = Plans;

// Icons
import { X } from "@styled-icons/feather/X";
import { ArrowRight } from "@styled-icons/feather/ArrowRight";
import { Star } from "@styled-icons/feather/Star";
import { Briefcase } from "@styled-icons/feather/Briefcase";
import { Users } from "@styled-icons/feather/Users";
import { UploadCloud } from "@styled-icons/feather/UploadCloud";
import { FileText } from "@styled-icons/feather/FileText";
import { Database } from "@styled-icons/feather/Database";
import { Clock } from "@styled-icons/feather/Clock";

const VISIBLE_KEYS = [PLAN_KEYS?.hobby, PLAN_KEYS?.business, PLAN_KEYS?.agency].filter(Boolean);

function fmtPrice(p) {
  const n = Number(p || 0) || 0;
  if (!n) return "Free";
  return `$${n}/mo`;
}

function safeBytes(n) {
  const x = Number(n || 0) || 0;
  return formatBytes ? formatBytes(x) : `${x}`;
}

function fmtInt(n) {
  const x = Number(n || 0) || 0;
  return Math.trunc(x).toLocaleString();
}

function getPlanIcon(planKey) {
  if (planKey === PLAN_KEYS?.hobby) return Star;
  if (planKey === PLAN_KEYS?.business) return Briefcase;
  if (planKey === PLAN_KEYS?.agency) return Users;
  return Star;
}

export default function UpgradePlansModal({ open, onClose, onSelectPlan, busyPlanKey, onLogout }) {
  const { billing, syncBilling, getJwt } = useAuth();

  const [portalBusy, setPortalBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    // keep plan info fresh when modal opens (your syncBilling is already throttled)
    syncBilling?.({}).catch(() => {});
  }, [open, syncBilling]);

  const handleOpenPortal = async () => {
    if (portalBusy) return;

    setPortalBusy(true);
    try {
      const jwt = await getJwt({ force: true });
      if (!jwt) throw new Error("Not authenticated");

      const res = await fetch("/api/billing/portal", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${jwt}`,
        },
        credentials: "include",
        body: JSON.stringify({
          returnPath: "/",
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.message || "Failed to open billing portal");
      if (!data?.url) throw new Error("Portal URL missing from server response");

      window.location.assign(String(data.url));
    } catch (e) {
      toast(e?.message || "Could not open billing portal");
    } finally {
      setPortalBusy(false);
    }
  };

  const visiblePlans = useMemo(() => {
    const list = Array.isArray(PLANS) ? PLANS : [];
    const byKey = {};
    for (const p of list) byKey[p?.key] = p;
    return VISIBLE_KEYS.map((k) => byKey[k]).filter(Boolean);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <Overlay
      role="dialog"
      aria-modal="true"
      aria-label="Upgrade plans"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose?.();
      }}
    >
      <Modal>
        <Header>
          <HeaderLeft>
            <TitleRow>
              <Title>Upgrade</Title>
            </TitleRow>
            <Sub>Pick a plan that matches your usage. You can switch later.</Sub>
          </HeaderLeft>

          <CloseButton type="button" onClick={onClose} aria-label="Close">
            <CloseIcon aria-hidden="true" />
          </CloseButton>
        </Header>

        <Body>
          <Cards>
            {visiblePlans.map((p, idx) => {
              const e = p.entitlements || {};
              const recommended = p.key === PLAN_KEYS?.business;
              const canCheckout = !!(p?.stripe?.priceIdMonthly);

              const busy = String(busyPlanKey || "") === String(p.key);

              const hasSub = !!billing?.hasSubscription;
              const currentKey = String(billing?.planKey || "");
              const isCurrentPlan = hasSub && currentKey && currentKey === String(p.key);

              const PlanIcon = getPlanIcon(p.key);

              // Decide CTA behavior (NO "change in portal")
              const ctaDisabled = busy || portalBusy || !canCheckout || isCurrentPlan;

              let ctaLabel = "Continue";
              let ctaHint = canCheckout
                ? "Secure checkout via Stripe."
                : "Enable by adding Stripe priceIdMonthly for this plan.";

              if (isCurrentPlan) {
                ctaLabel = "Current plan";
                ctaHint = "You’re on this plan.";
              } else if (!canCheckout) {
                ctaLabel = "Coming soon";
              } else if (busy) {
                ctaLabel = "Opening…";
              }

              return (
                <Card key={p.key} $recommended={recommended} style={{ animationDelay: `${idx * 55}ms` }}>
                  <CardTop>
                    <PlanLeft>
                      <PlanMark $recommended={recommended}>
                        <PlanIconStyled as={PlanIcon} aria-hidden="true" />
                      </PlanMark>

                      <PlanText>
                        <PlanNameRow>
                          <PlanName>{p.label}</PlanName>
                          {recommended ? <Badge>Recommended</Badge> : null}
                          {isCurrentPlan ? <ReadyTag>Active</ReadyTag> : null}
                        </PlanNameRow>

                        <PlanMeta>
                          <Price>{fmtPrice(p.priceUsdMonthly)}</Price>
                          {isCurrentPlan && billing?.subscriptionStatus ? (
                            <>
                              <Dot>•</Dot>
                              <SmallMuted>{String(billing.subscriptionStatus)}</SmallMuted>
                            </>
                          ) : null}
                        </PlanMeta>
                      </PlanText>
                    </PlanLeft>
                  </CardTop>

                  <Hero>
                    <HeroNumber>{Number(e.monthlyFloorMediaTokens || 0) || 0}</HeroNumber>
                    <HeroLabel>media tokens / month</HeroLabel>
                  </Hero>

                  <Features>
                    {/* Threads */}
                    <FeatureRow>
                      <FeatureIcon as={Users} aria-hidden="true" />
                      <FeatureLabel>Threads</FeatureLabel>
                      <FeatureValue>{fmtInt(e.threadLimit)}</FeatureValue>
                    </FeatureRow>

                    {/* Media upload / storage */}
                    <FeatureRow>
                      <FeatureIcon as={FileText} aria-hidden="true" />
                      <FeatureLabel>Max file</FeatureLabel>
                      <FeatureValue>{safeBytes(e.maxFileBytes)}</FeatureValue>
                    </FeatureRow>

                    <FeatureRow>
                      <FeatureIcon as={UploadCloud} aria-hidden="true" />
                      <FeatureLabel>Monthly upload</FeatureLabel>
                      <FeatureValue>{safeBytes(e.monthlyUploadBytesCap)}</FeatureValue>
                    </FeatureRow>

                    <FeatureRow>
                      <FeatureIcon as={Database} aria-hidden="true" />
                      <FeatureLabel>Active storage</FeatureLabel>
                      <FeatureValue>{safeBytes(e.activeStorageBytesCap)}</FeatureValue>
                    </FeatureRow>

                    <FeatureRow>
                      <FeatureIcon as={Clock} aria-hidden="true" />
                      <FeatureLabel>Retention</FeatureLabel>
                      <FeatureValue>{fmtInt(e.retentionDays)} days</FeatureValue>
                    </FeatureRow>

                    {/* Saving limits */}
                    <Divider />

                    <FeatureRow>
                      <FeatureIcon as={Star} aria-hidden="true" />
                      <FeatureLabel>Saved items</FeatureLabel>
                      <FeatureValue>{fmtInt(e.savedItemCountCap)}</FeatureValue>
                    </FeatureRow>

                    <FeatureRow>
                      <FeatureIcon as={FileText} aria-hidden="true" />
                      <FeatureLabel>Max saved item</FeatureLabel>
                      <FeatureValue>{safeBytes(e.maxSavedItemBytes)}</FeatureValue>
                    </FeatureRow>

                    <FeatureRow>
                      <FeatureIcon as={UploadCloud} aria-hidden="true" />
                      <FeatureLabel>Monthly saves</FeatureLabel>
                      <FeatureValue>{safeBytes(e.monthlySaveBytesCap)}</FeatureValue>
                    </FeatureRow>

                    <FeatureRow>
                      <FeatureIcon as={Database} aria-hidden="true" />
                      <FeatureLabel>Saved storage</FeatureLabel>
                      <FeatureValue>{safeBytes(e.savedStorageBytesCap)}</FeatureValue>
                    </FeatureRow>
                  </Features>

                  <CardBottom>
                    <CTA
                      type="button"
                      disabled={ctaDisabled}
                      $primary={recommended}
                      onClick={() => {
                        if (isCurrentPlan) return;

                        if (!canCheckout) {
                          toast("This plan isn’t purchasable yet (missing Stripe priceIdMonthly).");
                          return;
                        }

                        // always go to checkout (even if hasSubscription)
                        onSelectPlan?.(p.key);
                      }}
                    >
                      {ctaLabel}
                      <CTAIcon aria-hidden="true" />
                    </CTA>
                    <FootHint>{ctaHint}</FootHint>
                  </CardBottom>
                </Card>
              );
            })}
          </Cards>

          <FooterRow>
            <GhostLink type="button" onClick={handleOpenPortal} disabled={portalBusy}>
              {portalBusy ? "Opening…" : "Manage subscription"}
            </GhostLink>

            <RightFooter>
              {typeof onLogout === "function" ? (
                <LogoutLink type="button" onClick={onLogout}>
                  Log out
                </LogoutLink>
              ) : null}
            </RightFooter>
          </FooterRow>
        </Body>
      </Modal>
    </Overlay>
  );
}

const fadeIn = keyframes`
  from { opacity: 0; }
  to { opacity: 1; }
`;

const popIn = keyframes`
  from { transform: translateY(10px) scale(0.99); opacity: 0; }
  to { transform: translateY(0) scale(1); opacity: 1; }
`;

const cardIn = keyframes`
  from { transform: translateY(10px); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
`;

const Overlay = styled.div`
  position: fixed;
  inset: 0;
  z-index: 9999;

  display: grid;
  place-items: center;

  padding: 12px;

  background: rgba(0, 0, 0, 0.34);
  animation: ${fadeIn} 140ms ease both;

  @supports (backdrop-filter: blur(10px)) {
    backdrop-filter: blur(10px);
    background: rgba(0, 0, 0, 0.22);
  }

  @media (prefers-reduced-motion: reduce) {
    animation: none;
  }
`;

const Modal = styled.div`
  width: min(980px, calc(100vw - 24px));
  max-height: calc(100vh - 24px);

  border-radius: 18px;
  border: 1px solid var(--border);
  background: var(--panel);

  box-shadow: 0 28px 70px rgba(0, 0, 0, 0.26);
  overflow: hidden;

  animation: ${popIn} 180ms cubic-bezier(0.2, 0.9, 0.2, 1) both;

  @media (prefers-reduced-motion: reduce) {
    animation: none;
  }
`;

const Header = styled.div`
  padding: 14px 14px 12px 14px;
  border-bottom: 1px solid var(--border);

  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;

  background: linear-gradient(180deg, rgba(0, 0, 0, 0.03), transparent);
`;

const HeaderLeft = styled.div`
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
`;

const TitleRow = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  flex-wrap: wrap;
`;

const Title = styled.div`
  font-size: 16px;
  font-weight: 950;
  color: var(--text);
`;

const Sub = styled.div`
  font-size: 12px;
  color: var(--muted);
  line-height: 1.35;
  max-width: 78ch;
`;

const CloseButton = styled.button`
  width: 36px;
  height: 36px;
  border-radius: 12px;

  border: 1px solid var(--border);
  background: rgba(0, 0, 0, 0.02);
  color: var(--text);

  cursor: pointer;
  display: grid;
  place-items: center;

  transition: background 120ms ease, transform 120ms ease;

  &:hover {
    background: var(--hover);
    transform: translateY(-1px);
  }

  &:active {
    transform: translateY(0);
  }

  &:focus-visible {
    outline: none;
    box-shadow: 0 0 0 3px rgba(239, 68, 68, 0.14);
  }
`;

const CloseIcon = styled(X)`
  width: 18px;
  height: 18px;
  opacity: 0.9;
`;

const Body = styled.div`
  padding: 14px;
  overflow: auto;
`;

const Cards = styled.div`
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;

  @media (max-width: 920px) {
    grid-template-columns: 1fr;
  }
`;

const Card = styled.div`
  position: relative;
  border-radius: 16px;
  border: 1px solid ${(p) => (p.$recommended ? "rgba(239, 68, 68, 0.22)" : "var(--border)")};
  background: ${(p) => (p.$recommended ? "rgba(239, 68, 68, 0.03)" : "rgba(0, 0, 0, 0.02)")};

  padding: 12px;
  overflow: hidden;

  animation: ${cardIn} 200ms ease both;
  transition: transform 140ms ease, box-shadow 140ms ease, background 140ms ease, border-color 140ms ease;

  &:hover {
    transform: translateY(-2px);
    background: ${(p) => (p.$recommended ? "rgba(239, 68, 68, 0.04)" : "rgba(0, 0, 0, 0.03)")};
    box-shadow: ${(p) =>
      p.$recommended ? "0 18px 44px rgba(239, 68, 68, 0.08)" : "0 16px 40px rgba(0, 0, 0, 0.10)"};
  }

  @media (prefers-reduced-motion: reduce) {
    animation: none;
    &:hover {
      transform: none;
    }
  }
`;

const CardTop = styled.div`
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;

  padding-top: 2px;
`;

const PlanLeft = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
`;

const PlanMark = styled.div`
  width: 38px;
  height: 38px;
  border-radius: 12px;

  border: 1px solid ${(p) => (p.$recommended ? "rgba(239, 68, 68, 0.22)" : "var(--border)")};
  background: ${(p) => (p.$recommended ? "rgba(239, 68, 68, 0.06)" : "rgba(0, 0, 0, 0.02)")};

  display: grid;
  place-items: center;
  flex: 0 0 auto;
`;

const PlanIconStyled = styled.span`
  width: 18px;
  height: 18px;
  opacity: 0.85;
`;

const PlanText = styled.div`
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
`;

const PlanNameRow = styled.div`
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
`;

const PlanName = styled.div`
  font-size: 14px;
  font-weight: 950;
  color: var(--text);
  min-width: 0;
`;

const Badge = styled.span`
  font-size: 10px;
  font-weight: 900;
  padding: 3px 8px;
  border-radius: 999px;

  border: 1px solid rgba(239, 68, 68, 0.22);
  background: rgba(239, 68, 68, 0.08);
  color: var(--accent);

  white-space: nowrap;
`;

const PlanMeta = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
`;

const Price = styled.div`
  font-size: 12px;
  font-weight: 950;
  color: var(--text);
`;

const Dot = styled.span`
  opacity: 0.35;
`;

const SmallMuted = styled.div`
  font-size: 12px;
  font-weight: 800;
  color: var(--muted);
`;

const ReadyTag = styled.div`
  font-size: 11px;
  font-weight: 850;
  color: rgba(34, 197, 94, 1);

  border: 1px solid rgba(34, 197, 94, 0.22);
  background: rgba(34, 197, 94, 0.06);
  padding: 6px 10px;
  border-radius: 999px;
  white-space: nowrap;
`;

const Hero = styled.div`
  margin-top: 12px;
  padding: 12px;

  border-radius: 14px;
  border: 1px solid var(--border);
  background: rgba(255, 255, 255, 0.02);
`;

const HeroNumber = styled.div`
  font-size: 24px;
  font-weight: 1000;
  color: var(--text);
  line-height: 1.05;
`;

const HeroLabel = styled.div`
  margin-top: 4px;
  font-size: 11px;
  color: var(--muted);
  font-weight: 850;
`;

const Features = styled.div`
  margin-top: 10px;
  display: grid;
  gap: 3px;
`;

const Divider = styled.div`
  height: 1px;
  background: var(--border);
  opacity: 0.75;
  border-radius: 999px;
  margin: 4px 2px;
`;

const FeatureRow = styled.div`
  border: 1px solid var(--border);
  background: rgba(0, 0, 0, 0.02);
  border-radius: 12px;
  padding: 6px 6px;

  display: grid;
  grid-template-columns: 18px 1fr auto;
  align-items: center;
  gap: 10px;
`;

const FeatureIcon = styled.span`
  width: 16px;
  height: 16px;
  opacity: 0.75;
`;

const FeatureLabel = styled.div`
  font-size: 12px;
  font-weight: 850;
  color: var(--muted);
`;

const FeatureValue = styled.div`
  font-size: 12px;
  font-weight: 950;
  color: var(--text);
  text-align: right;
`;

const CardBottom = styled.div`
  margin-top: 12px;
`;

const CTA = styled.button`
  width: 100%;
  border-radius: 14px;
  padding: 11px 12px;

  cursor: pointer;
  border: 1px solid ${(p) => (p.$primary ? "rgba(239, 68, 68, 0.26)" : "var(--border)")};
  background: ${(p) => (p.$primary ? "rgba(239, 68, 68, 0.10)" : "var(--panel)")};
  color: var(--text);

  font-weight: 950;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;

  transition: transform 120ms ease, background 120ms ease, border-color 120ms ease, box-shadow 120ms ease;

  &:hover {
    transform: translateY(-1px);
    background: ${(p) => (p.$primary ? "rgba(239, 68, 68, 0.12)" : "var(--hover)")};
    border-color: ${(p) => (p.$primary ? "rgba(239, 68, 68, 0.32)" : "rgba(0,0,0,0.12)")};
    box-shadow: ${(p) =>
      p.$primary ? "0 12px 28px rgba(239, 68, 68, 0.08)" : "0 12px 26px rgba(0, 0, 0, 0.10)"};
  }

  &:active {
    transform: translateY(0px) scale(0.995);
  }

  &:focus-visible {
    outline: none;
    box-shadow: 0 0 0 3px rgba(239, 68, 68, 0.14);
  }

  &:disabled {
    opacity: 0.55;
    cursor: not-allowed;
    transform: none;
    box-shadow: none;
  }
`;

const CTAIcon = styled(ArrowRight)`
  width: 16px;
  height: 16px;
  opacity: 0.85;
`;

const FootHint = styled.div`
  margin-top: 7px;
  font-size: 11px;
  color: var(--muted);
  font-weight: 800;
  text-align: center;
`;

const FooterRow = styled.div`
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid var(--border);

  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
`;

const RightFooter = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;
`;

const GhostLink = styled.button`
  border: 1px solid transparent;
  background: transparent;
  color: var(--muted);
  font-weight: 850;
  cursor: pointer;
  padding: 6px 8px;
  border-radius: 10px;

  transition: background 120ms ease, color 120ms ease, border-color 120ms ease;

  &:hover {
    color: var(--text);
    background: rgba(0, 0, 0, 0.03);
    border-color: rgba(0, 0, 0, 0.06);
  }

  &:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  &:focus-visible {
    outline: none;
    box-shadow: 0 0 0 3px rgba(239, 68, 68, 0.12);
  }
`;

const LogoutLink = styled.button`
  border: 1px solid transparent;
  background: transparent;
  color: var(--text);
  font-weight: 900;
  cursor: pointer;
  opacity: 0.92;
  padding: 6px 8px;
  border-radius: 10px;

  transition: background 120ms ease, opacity 120ms ease;

  &:hover {
    opacity: 1;
    background: rgba(0, 0, 0, 0.03);
  }

  &:focus-visible {
    outline: none;
    box-shadow: 0 0 0 3px rgba(239, 68, 68, 0.12);
  }
`;
