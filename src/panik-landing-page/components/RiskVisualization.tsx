/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from "react";

export function RiskVisualization() {
  const [activeTab, setActiveTab] = useState<"CALM" | "LIQUIDITY" | "CRASH">("CALM");
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [isInView, setIsInView] = useState(false);
  const sectionRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = sectionRef.current;
    if (!element) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsInView(true);
          observer.unobserve(element);
        }
      },
      {
        threshold: 0.15,
      }
    );

    observer.observe(element);
    return () => {
      if (element) {
        observer.unobserve(element);
      }
    };
  }, []);

  const getScore = () => {
    if (activeTab === "CALM") return 22;
    if (activeTab === "LIQUIDITY") return 47;
    return 81;
  };

  const getLabel = () => {
    if (activeTab === "CALM") return "LOW";
    if (activeTab === "LIQUIDITY") return "ELEVATED";
    return "CRITICAL";
  };

  const getActiveColor = () => {
    if (activeTab === "CALM") return "#22C55E";
    if (activeTab === "LIQUIDITY") return "#F59E0B";
    return "#DC2626";
  };

  const getBorderColor = () => {
    if (activeTab === "CALM") return "rgba(34,197,94,0.40)";
    if (activeTab === "LIQUIDITY") return "rgba(245,158,11,0.40)";
    return "rgba(220,38,38,0.40)";
  };

  const getSummary = () => {
    if (activeTab === "CALM") {
      return "All three risk levels are operating within safe ranges. Your position health and liquidity are stable. No action needed.";
    }
    if (activeTab === "LIQUIDITY") {
      return "Pool utilization is elevated. Withdrawal windows may narrow if conditions continue. Position health remains stable but worth monitoring.";
    }
    return "Severe market-wide stress detected. Volatility is high, liquidity is constrained, and multiple positions are approaching critical thresholds. Immediate attention required.";
  };

  const handleTabSwitch = (tab: "CALM" | "LIQUIDITY" | "CRASH") => {
    if (tab === activeTab || isTransitioning) return;
    setIsTransitioning(true);
    setTimeout(() => {
      setActiveTab(tab);
      setIsTransitioning(false);
    }, 150);
  };

  return (
    <section
      ref={sectionRef}
      className={`re-section-wrapper ${isInView ? "re-in-view" : ""}`}
      id="scoring"
    >
      <style dangerouslySetInnerHTML={{ __html: `
        .re-section-wrapper {
          background-color: #09090B;
          padding: 120px 24px;
          width: 100%;
          overflow: hidden;
          color: #F8FAFC;
          box-sizing: border-box;
        }
        .re-container {
          max-width: 1200px;
          margin: 0 auto;
          display: flex;
          flex-direction: column;
        }
        
        /* Part 3 - Header */
        .re-header {
          text-align: center;
          max-width: 560px;
          margin: 0 auto;
          display: flex;
          flex-direction: column;
          align-items: center;
        }
        .re-eyebrow {
          font-family: 'JetBrains Mono', monospace;
          font-size: 11px;
          font-weight: 500;
          color: #F97316;
          text-transform: uppercase;
          letter-spacing: 0.09em;
          margin-bottom: 16px;
          line-height: 1;
        }
        .re-headline {
          font-family: 'Inter', system-ui, -apple-system, sans-serif;
          font-size: 48px;
          font-weight: 700;
          color: #F8FAFC;
          letter-spacing: -0.02em;
          line-height: 1.1;
          margin: 0 0 20px 0;
        }
        .re-subhead {
          font-family: 'Inter', system-ui, -apple-system, sans-serif;
          font-size: 17px;
          font-weight: 400;
          color: #94A3B8;
          line-height: 1.7;
          margin: 0 0 56px 0;
          text-align: center;
        }
        
        /* Part 4 - Tab Buttons */
        .re-tabs-wrapper {
          display: flex;
          justify-content: center;
          margin-bottom: 48px;
        }
        .re-tabs-container {
          display: inline-flex;
          background: rgba(255,255,255,0.03);
          border: 0.5px solid rgba(255,255,255,0.07);
          border-radius: 10px;
          padding: 4px;
          gap: 8px;
        }
        .re-tab-btn {
          background: transparent;
          border: none;
          border-radius: 7px;
          color: #7A8699;
          font-family: 'JetBrains Mono', monospace;
          font-size: 11px;
          font-weight: 500;
          text-transform: uppercase;
          letter-spacing: 0.07em;
          padding: 10px 18px;
          cursor: pointer;
          transition: all 0.2s ease;
          line-height: 1;
        }
        .re-tab-btn:hover {
          color: #94A3B8;
          background: rgba(255,255,255,0.04);
        }
        .re-tab-btn.re-active {
          background: rgba(249,115,22,0.12);
          border: 0.5px solid rgba(249,115,22,0.30);
          color: #F97316;
        }
        
        /* Part 5 - Two-Column Panel */
        .re-content-panel-wrapper {
          position: relative;
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 32px;
          align-items: start;
        }
        .re-card {
          background: rgba(255,255,255,0.03);
          border: 0.5px solid rgba(255,255,255,0.08);
          border-radius: 14px;
          backdrop-filter: blur(12px);
          -webkit-backdrop-filter: blur(12px);
          padding: 32px;
          box-sizing: border-box;
          transition: box-shadow 0.3s ease, border-color 0.3s ease;
        }
        .re-card-title {
          font-family: 'Inter', system-ui, -apple-system, sans-serif;
          font-size: 20px;
          font-weight: 600;
          color: #F8FAFC;
          margin: 0 0 6px 0;
          line-height: 1.2;
        }
        .re-card-subtitle {
          font-family: 'Inter', system-ui, -apple-system, sans-serif;
          font-size: 14px;
          font-weight: 400;
          color: #94A3B8;
          margin: 0 0 28px 0;
          line-height: 1.4;
        }
        
        /* Signal Rows */
        .re-signal-rows {
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .re-signal-row {
          position: relative;
          display: flex;
          border-radius: 8px;
          padding: 14px 16px;
          box-sizing: border-box;
          overflow: hidden;
        }
        .re-signal-accent {
          position: absolute;
          left: 0;
          top: 0;
          bottom: 0;
          width: 3px;
          border-radius: 2px;
        }
        .re-signal-content {
          display: flex;
          flex-direction: column;
          width: 100%;
          padding-left: 8px;
        }
        .re-signal-header {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 4px;
        }
        .re-signal-dot {
          width: 12px;
          height: 12px;
          border-radius: 50%;
          flex-shrink: 0;
        }
        .re-signal-title {
          font-family: 'JetBrains Mono', monospace;
          font-size: 12px;
          font-weight: 500;
          text-transform: uppercase;
          letter-spacing: 0.07em;
        }
        .re-signal-desc {
          font-family: 'Inter', system-ui, -apple-system, sans-serif;
          font-size: 13px;
          color: #94A3B8;
          line-height: 1.5;
          margin: 0;
        }
        
        /* Row Variants */
        .re-signal-row.re-protocol {
          background: rgba(20,184,166,0.05);
          border: 0.5px solid rgba(20,184,166,0.15);
        }
        .re-signal-row.re-protocol .re-signal-accent {
          background-color: #14B8A6;
        }
        .re-signal-row.re-protocol .re-signal-dot {
          background-color: #14B8A6;
        }
        .re-signal-row.re-protocol .re-signal-title {
          color: #14B8A6;
        }
        
        .re-signal-row.re-pool {
          background: rgba(245,158,11,0.05);
          border: 0.5px solid rgba(245,158,11,0.15);
        }
        .re-signal-row.re-pool .re-signal-accent {
          background-color: #F59E0B;
        }
        .re-signal-row.re-pool .re-signal-dot {
          background-color: #F59E0B;
        }
        .re-signal-row.re-pool .re-signal-title {
          color: #F59E0B;
        }
        
        .re-signal-row.re-position {
          background: rgba(249,115,22,0.05);
          border: 0.5px solid rgba(249,115,22,0.15);
        }
        .re-signal-row.re-position .re-signal-accent {
          background-color: #F97316;
        }
        .re-signal-row.re-position .re-signal-dot {
          background-color: #F97316;
        }
        .re-signal-row.re-position .re-signal-title {
          color: #F97316;
        }
        
        /* Connector chevron / arrow */
        .re-connector {
          position: absolute;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          color: rgba(255,255,255,0.15);
          font-size: 20px;
          z-index: 10;
          pointer-events: none;
          font-family: inherit;
        }
        
        /* Right panel layout */
        .re-right-panel-content {
          opacity: 1;
          transform: translateY(0);
          transition: opacity 0.2s cubic-bezier(0.16, 1, 0.3, 1), transform 0.2s cubic-bezier(0.16, 1, 0.3, 1);
        }
        .re-right-panel-content.re-switching {
          opacity: 0;
          transform: translateY(-6px);
          transition: opacity 0.15s ease-out, transform 0.15s ease-out;
        }
        
        /* Score Display Area */
        .re-score-header {
          display: flex;
          align-items: baseline;
          gap: 12px;
          margin-bottom: 16px;
        }
        .re-score-number {
          font-family: 'JetBrains Mono', monospace;
          font-size: 56px;
          font-weight: 700;
          line-height: 1;
          transition: color 0.35s ease;
        }
        .re-score-label {
          font-family: 'JetBrains Mono', monospace;
          font-size: 12px;
          font-weight: 500;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          transition: color 0.35s ease;
        }
        
        .re-score-bar-container {
          position: relative;
          display: flex;
          width: 100%;
          height: 6px;
          border-radius: 3px;
          background: rgba(255,255,255,0.03);
          overflow: visible;
          margin-bottom: 24px;
          box-sizing: border-box;
        }
        .re-score-bar-segment {
          flex: 1;
          height: 100%;
        }
        .re-score-bar-segment:nth-child(1) {
          background-color: #22C55E;
          border-top-left-radius: 3px;
          border-bottom-left-radius: 3px;
        }
        .re-score-bar-segment:nth-child(2) {
          background-color: #F59E0B;
        }
        .re-score-bar-segment:nth-child(3) {
          background-color: #EF4444;
        }
        .re-score-bar-segment:nth-child(4) {
          background-color: #DC2626;
          border-top-right-radius: 3px;
          border-bottom-right-radius: 3px;
        }
        .re-score-bar-marker {
          position: absolute;
          top: 50%;
          transform: translate(-50%, -50%);
          width: 10px;
          height: 10px;
          border-radius: 50%;
          border: 2px solid #FFFFFF;
          box-sizing: border-box;
          transition: left 0.35s cubic-bezier(0.16, 1, 0.3, 1), background-color 0.35s ease;
          z-index: 5;
        }
        
        /* Risk Summary Container */
        .re-summary-container {
          background: rgba(255,255,255,0.02);
          border: 0.5px solid rgba(255,255,255,0.06);
          border-radius: 8px;
          padding: 16px;
          box-sizing: border-box;
          transition: border-left-color 0.35s ease;
        }
        .re-summary-text {
          font-family: 'Inter', system-ui, -apple-system, sans-serif;
          font-size: 14px;
          font-weight: 400;
          color: #94A3B8;
          line-height: 1.75;
          margin: 0;
        }
        
        /* Critical state glowing */
        .re-card.re-card-critical {
          border-color: rgba(220, 38, 38, 0.2);
          box-shadow: 0 0 0 1px rgba(220, 38, 38, 0.12),
                      0 4px 24px rgba(220, 38, 38, 0.08);
        }
        
        /* Bottom Caption */
        .re-caption {
          font-family: 'Inter', system-ui, -apple-system, sans-serif;
          font-size: 14px;
          font-weight: 400;
          color: #7A8699;
          text-align: center;
          margin-top: 32px;
          max-width: 520px;
          align-self: center;
          line-height: 1.5;
        }
        
        /* Responsive states */
        @media (max-width: 1023px) {
          .re-content-panel-wrapper {
            grid-template-columns: 1fr;
            gap: 24px;
          }
          .re-connector {
            display: none;
          }
          .re-headline {
            font-size: 36px;
          }
          .re-section-wrapper {
            padding: 80px 16px;
          }
        }
        
        /* Scroll reveal base classes */
        .re-animate-fade-up {
          opacity: 0;
          transform: translateY(16px);
          transition: transform 0.5s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.5s cubic-bezier(0.16, 1, 0.3, 1);
        }
        .re-in-view .re-animate-fade-up {
          opacity: 1;
          transform: translateY(0);
        }
        
        .re-animate-tabs {
          opacity: 0;
          transform: translateY(16px);
          transition: transform 0.4s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.4s cubic-bezier(0.16, 1, 0.3, 1);
          transition-delay: 80ms;
        }
        .re-in-view .re-animate-tabs {
          opacity: 1;
          transform: translateY(0);
        }
        
        .re-animate-left {
          opacity: 0;
          transform: translateX(-16px);
          transition: transform 0.5s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.5s cubic-bezier(0.16, 1, 0.3, 1);
          transition-delay: 160ms;
        }
        .re-in-view .re-animate-left {
          opacity: 1;
          transform: translateX(0);
        }
        
        .re-animate-right {
          opacity: 0;
          transform: translateX(16px);
          transition: transform 0.5s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.5s cubic-bezier(0.16, 1, 0.3, 1);
          transition-delay: 240ms;
        }
        .re-in-view .re-animate-right {
          opacity: 1;
          transform: translateX(0);
        }
        
        .re-animate-caption {
          opacity: 0;
          transition: opacity 0.4s cubic-bezier(0.16, 1, 0.3, 1);
          transition-delay: 400ms;
        }
        .re-in-view .re-animate-caption {
          opacity: 1;
        }
      ` }} />
      <div className="re-container">
        {/* Part 3: Header */}
        <div className="re-header re-animate-fade-up">
          <div className="re-eyebrow">RISK EVALUATION METHODOLOGY</div>
          <h2 className="re-headline">How the Panik Risk Engine Works</h2>
          <p className="re-subhead">
            A multi-dimensional framework that evaluates every layer of position risk before it becomes a problem.
          </p>
        </div>

        {/* Part 4: Tab Buttons */}
        <div className="re-tabs-wrapper re-animate-tabs">
          <div className="re-tabs-container">
            <button
              className={`re-tab-btn ${activeTab === "CALM" ? "re-active" : ""}`}
              onClick={() => handleTabSwitch("CALM")}
            >
              CALM MARKET
            </button>
            <button
              className={`re-tab-btn ${activeTab === "LIQUIDITY" ? "re-active" : ""}`}
              onClick={() => handleTabSwitch("LIQUIDITY")}
            >
              LIQUIDITY CRUNCH
            </button>
            <button
              className={`re-tab-btn ${activeTab === "CRASH" ? "re-active" : ""}`}
              onClick={() => handleTabSwitch("CRASH")}
            >
              MARKET CRASH
            </button>
          </div>
        </div>

        {/* Part 5: Two-column Panel */}
        <div className="re-content-panel-wrapper">
          {/* Left Card */}
          <div className="re-card re-left-card re-animate-left">
            <h3 className="re-card-title">Three-Level Risk Scoring</h3>
            <p className="re-card-subtitle">
              Each level runs independently and feeds into your unified score.
            </p>

            <div className="re-signal-rows">
              {/* Row 1 */}
              <div className="re-signal-row re-protocol">
                <div className="re-signal-accent"></div>
                <div className="re-signal-content">
                  <div className="re-signal-header">
                    <div className="re-signal-dot"></div>
                    <div className="re-signal-title">Protocol Score</div>
                  </div>
                  <p className="re-signal-desc">
                    Assesses protocol reliability, audit history, exploit track record, and governance stability.
                  </p>
                </div>
              </div>

              {/* Row 2 */}
              <div className="re-signal-row re-pool">
                <div className="re-signal-accent"></div>
                <div className="re-signal-content">
                  <div className="re-signal-header">
                    <div className="re-signal-dot"></div>
                    <div className="re-signal-title">Pool Score</div>
                  </div>
                  <p className="re-signal-desc">
                    Monitors pool utilization, oracle reliability, and withdrawal accessibility.
                  </p>
                </div>
              </div>

              {/* Row 3 */}
              <div className="re-signal-row re-position">
                <div className="re-signal-accent"></div>
                <div className="re-signal-content">
                  <div className="re-signal-header">
                    <div className="re-signal-dot"></div>
                    <div className="re-signal-title">Position Score</div>
                  </div>
                  <p className="re-signal-desc">
                    Evaluates your health factor, liquidation distance, and collateral strength in real time.
                  </p>
                </div>
              </div>
            </div>
          </div>

          <div className="re-connector">→</div>

          {/* Right Card */}
          <div
            className={`re-card re-right-card re-animate-right ${
              activeTab === "CRASH" ? "re-card-critical" : ""
            }`}
          >
            <h3 className="re-card-title">Panik Risk Score</h3>
            <p className="re-card-subtitle">
              Three independent risk levels synthesized into one actionable score.
            </p>

            <div
              className={`re-right-panel-content ${
                isTransitioning ? "re-switching" : ""
              }`}
            >
              <div className="re-score-header">
                <div
                  className="re-score-number"
                  style={{ color: getActiveColor() }}
                >
                  {getScore()}
                </div>
                <div
                  className="re-score-label"
                  style={{ color: getActiveColor() }}
                >
                  {getLabel()}
                </div>
              </div>

              <div className="re-score-bar-container">
                <div className="re-score-bar-segment"></div>
                <div className="re-score-bar-segment"></div>
                <div className="re-score-bar-segment"></div>
                <div className="re-score-bar-segment"></div>
                <div
                  className="re-score-bar-marker"
                  style={{
                    left: `${getScore()}%`,
                    backgroundColor: getActiveColor(),
                  }}
                ></div>
              </div>

              <div
                className="re-summary-container"
                style={{ borderLeft: `3px solid ${getBorderColor()}` }}
              >
                <p className="re-summary-text">{getSummary()}</p>
              </div>
            </div>
          </div>
        </div>

        {/* Part 6: Bottom Caption */}
        <div className="re-caption re-animate-caption">
          A unified score that turns three independent risk levels into one clear, actionable status.
        </div>
      </div>
    </section>
  );
}

