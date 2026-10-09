import { YoutubeUrlForm } from "@/components/YoutubeUrlForm";
import { StudioSection } from "@/components/studio/StudioSection";
import { buildDemoProject } from "@/lib/demo/buildDemoProject";

const STEPS = [
  ["01", "Une source", "Collez un lien YouTube public ou importez votre média. PeakCut ne lance rien sans votre action."],
  ["02", "Une lecture", "Transcription horodatée, changements de rythme et score éditorial : chaque signal reste compréhensible."],
  ["03", "Un montage", "Choisissez un moment, corrigez chaque mot, cadrez en 9:16 et prévisualisez avant d’exporter."],
];

const SIGNALS = [
  { label: "Accroche", value: "92", tone: "orange" },
  { label: "Densité", value: "78", tone: "violet" },
  { label: "Autonomie", value: "86", tone: "lime" },
];

const FAQ = [
  ["Le score connaît-il le watch time réel ?", "Non. Pour une vidéo tierce, PeakCut produit un score de potentiel de rétention explicable. Les statistiques réelles sont réservées à une chaîne connectée par OAuth."],
  ["Puis-je voir le produit sans compte ?", "Oui. La démonstration publique montre le parcours, le transcript, le score, la timeline et le cadrage. La personnalisation, l’import serveur et le téléchargement nécessitent un compte."],
  ["PeakCut publie-t-il automatiquement ?", "Non. Un export ou une publication reste soumis à votre confirmation humaine et à la confirmation que vous disposez des droits nécessaires."],
];

export default async function Home() {
  const demoProject = await buildDemoProject();

  return (
    <div className="landing-shell">
      <header className="landing-nav">
        <a href="#top" className="brand-mark" aria-label="PeakCut, accueil">
          <span className="brand-dot" />Peak<span>Cut</span>
        </a>
        <nav aria-label="Navigation principale" className="landing-links">
          <a href="#methode">Méthode</a>
          <a href="#studio">Studio</a>
          <a href="#controle">Contrôle</a>
          <a href="#faq">FAQ</a>
        </nav>
        <a href="#studio" className="nav-cta">Voir la démo <span>↗</span></a>
      </header>

      <main id="top">
        <section className="hero-section">
          <div className="hero-orbit hero-orbit-one" aria-hidden="true" />
          <div className="hero-orbit hero-orbit-two" aria-hidden="true" />
          <div className="hero-backdrop" aria-hidden="true" />
          <div className="hero-copy">
            <div className="eyebrow"><span className="eyebrow-pulse" /> Édition vidéo assistée · validation humaine</div>
            <h1>Les meilleurs moments<br /><em>méritent mieux</em> qu’un bouton.</h1>
            <p className="hero-lede">PeakCut transforme une vidéo longue en extraits verticaux pensés pour être compris, édités et validés — pas en clips générés à l’aveugle.</p>
            <div className="hero-form-wrap"><YoutubeUrlForm /></div>
          </div>

          <div className="hero-product" aria-label="Aperçu de l’interface PeakCut">
            <div className="product-glow" aria-hidden="true" />
            <div className="floating-chip chip-top"><span className="chip-live" /> Analyse terminée <strong>04:32</strong></div>
            <div className="editor-window">
              <div className="editor-topbar"><div className="window-lights"><i /><i /><i /></div><span>peakcut / studio</span><b>•••</b></div>
              <div className="editor-body">
                <div className="editor-sidebar"><div className="sidebar-logo">PC</div><div className="sidebar-line active" /><div className="sidebar-line" /><div className="sidebar-line" /><div className="sidebar-spacer" /><div className="sidebar-avatar">PD</div></div>
                <div className="editor-main">
                  <div className="editor-heading"><div><small>PROJET · PODCAST</small><h2>Les signaux faibles</h2></div><span className="status-pill">Prêt à éditer</span></div>
                  <div className="editor-content">
                    <div className="video-frame"><div className="video-scan" /><div className="video-person"><div className="person-head" /><div className="person-body" /></div><div className="video-caption">« Le moment où tout<br /><b>change de perspective.</b> »</div><span className="frame-tag">9:16 · SAFE</span></div>
                    <div className="signal-panel"><div className="signal-title">Potentiel éditorial <strong>84<span>/100</span></strong></div>{SIGNALS.map((signal) => <div className="signal-row" key={signal.label}><span>{signal.label}</span><div className="signal-track"><i className={signal.tone} style={{ width: `${signal.value}%` }} /></div><b>{signal.value}</b></div>)}<div className="reason-box">↳ <span>Accroche autonome<br />+ changement de rythme</span></div></div>
                  </div>
                  <div className="mini-timeline"><span className="time-label">00:00</span><div className="waveform">{Array.from({ length: 46 }, (_, i) => <i key={i} style={{ height: `${18 + ((i * 17) % 34)}%` }} />)}<b className="timeline-selection" /></div><span className="time-label">01:24</span></div>
                </div>
              </div>
            </div>
            <div className="floating-chip chip-bottom"><span className="spark">✦</span> Transcript mot-à-mot <strong>éditable</strong></div>
          </div>
        </section>

        <section className="trust-strip" aria-label="Principes PeakCut">
          <span>Pas de viralité garantie</span><i /> <span>Pas de publication implicite</span><i /> <span>Pas de boîte noire</span><i /> <span>Votre décision finale</span>
        </section>

        <section id="methode" className="story-section section-pad">
          <div className="section-kicker">La méthode PeakCut <span>— 01</span></div>
          <div className="section-heading-row"><h2>De la vidéo brute<br /><em>à l’idée nette.</em></h2><p>Un bon Short n’est pas seulement court. Il doit commencer au bon endroit, rester compréhensible et laisser le monteur décider.</p></div>
          <div className="step-grid">{STEPS.map(([number, title, body]) => <article className="step-card" key={number}><span className="step-number">{number}</span><div className="step-mark">{number === "01" ? "↘" : number === "02" ? "◌" : "✦"}</div><h3>{title}</h3><p>{body}</p><span className="step-arrow">↗</span></article>)}</div>
        </section>

        <section id="controle" className="control-section section-pad">
          <div className="control-visual"><div className="control-ring ring-a" /><div className="control-ring ring-b" /><div className="control-card"><div className="control-card-top"><span>Décision humaine</span><span className="check-mark">✓</span></div><div className="quote-line">« La nuance n’est pas<br /><em>un détour.</em> »</div><div className="control-meta"><span>00:42 — 01:07</span><span>Score 91</span></div><div className="control-actions"><button type="button">Conserver</button><button type="button">Ajuster</button></div></div><div className="control-orb">✦</div></div>
          <div className="control-copy"><div className="section-kicker">Pas une machine à clips <span>— 02</span></div><h2>Vous gardez<br /><em>le dernier mot.</em></h2><p>Chaque proposition vient avec son contexte, son horodatage et ses raisons. Corrigez un mot, déplacez une coupe, changez le cadrage : le résultat vous appartient.</p><ul><li><span>01</span> Transcript mot-à-mot éditable</li><li><span>02</span> Score prédictif, jamais présenté comme une vérité</li><li><span>03</span> Export bloqué tant que les droits ne sont pas confirmés</li></ul><a href="#studio" className="text-link">Explorer le studio <span>↗</span></a></div>
        </section>

        <section className="feature-section section-pad"><div className="section-kicker">Pensé pour le vertical <span>— 03</span></div><div className="feature-header"><h2>Un montage qui<br /><em>se lit à l’écran.</em></h2><p>Le cadrage, le rythme et les sous-titres ne sont pas des finitions. Ce sont les trois premières secondes de votre vidéo.</p></div><div className="feature-grid"><article className="feature-card feature-wide"><div className="feature-art crop-art"><span className="crop-box">SUJET</span><span className="safe-zone">SAFE ZONE</span><i className="crosshair" /></div><div className="feature-card-copy"><span>01 / Cadrage</span><h3>Le sujet reste<br />dans le cadre.</h3><p>Variantes 9:16, 1:1, 4:5 et 16:9, zones sûres et suivi derrière des adaptateurs remplaçables.</p></div></article><article className="feature-card"><div className="feature-art word-art"><span>chaque</span><b>mot</b><span>compte.</span><i /></div><div className="feature-card-copy"><span>02 / Sous-titres</span><h3>Le texte suit<br />la voix.</h3><p>Horodatage mot-à-mot, styles lisibles et corrections directement dans l’éditeur.</p></div></article><article className="feature-card"><div className="feature-art score-art"><strong>84</strong><small>/100</small><div className="score-arc" /></div><div className="feature-card-copy"><span>03 / Lecture</span><h3>Comprendre<br />avant de couper.</h3><p>Accroche, densité, questions, émotion et autonomie du passage : le score se justifie.</p></div></article></div></section>

        <section id="studio" className="demo-section section-pad"><div className="demo-head"><div><div className="section-kicker">Essayez sans compte <span>— 04</span></div><h2>Voyez le travail<br /><em>avant de vous engager.</em></h2></div><p>La démo publique est consultable en lecture seule. Connectez-vous pour importer, personnaliser et télécharger.</p></div><StudioSection initialProject={demoProject} publicDemo /></section>

        <section className="rights-band"><div><span className="rights-icon">◉</span><h2>Une vidéo publique n’est pas<br /><em>une licence de réutilisation.</em></h2></div><p>PeakCut vous demande de confirmer vos droits avant export. Simple, visible, humain.</p></section>

        <section id="faq" className="faq-section section-pad"><div className="section-kicker">Questions fréquentes <span>— 05</span></div><div className="faq-layout"><h2>Avant le<br /><em>premier cut.</em></h2><div className="faq-list">{FAQ.map(([question, answer]) => <details key={question}><summary>{question}<span>＋</span></summary><p>{answer}</p></details>)}</div></div></section>

        <section className="final-cta"><div className="cta-noise" /><div className="section-kicker">Le prochain bon moment est peut-être déjà là <span>✦</span></div><h2>Coupez moins.<br /><em>Décidez mieux.</em></h2><a href="#studio" className="primary-cta">Ouvrir la démonstration <span>↗</span></a><p>Consultation libre · Personnalisation après connexion · Aucun contenu publié automatiquement</p></section>
      </main>

      <footer className="landing-footer"><a href="#top" className="brand-mark"><span className="brand-dot" />Peak<span>Cut</span></a><p>Extraction éditoriale de moments forts.</p><div><a href="#faq">FAQ</a><a href="#studio">Démo</a><a href="#top">Retour en haut ↑</a></div></footer>
    </div>
  );
}
