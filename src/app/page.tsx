import { YoutubeUrlForm } from "@/components/YoutubeUrlForm";
import { StudioSection } from "@/components/studio/StudioSection";
import { buildDemoProject } from "@/lib/demo/buildDemoProject";

const STEPS = [
  {
    title: "1. Coller un lien public",
    body: "Collez l'URL d'une vidéo YouTube publique ou importez un fichier local. L'URL est validée de façon strictement structurelle : aucun téléchargement, aucun appel à une API externe.",
  },
  {
    title: "2. Transcription mot-à-mot",
    body: "Un fournisseur de transcription (démo hors-ligne incluse, adaptateurs OpenAI et AssemblyAI prêts à brancher) produit un transcript mot par mot avec horodatage et locuteur.",
  },
  {
    title: "3. Score explicable",
    body: "Chaque segment candidat reçoit un score éditorial détaillé (accroche, densité lexicale, question, émotion, changement de locuteur, durée, pénalités) — jamais un score de « viralité garantie ».",
  },
  {
    title: "4. Édition & cadrage",
    body: "Corrigez le texte, les bornes de début/fin et le cadrage par variante (9:16, 1:1, 4:5), avec visualisation des zones à ne pas masquer (safe zones), même sans média chargé.",
  },
  {
    title: "5. Export vertical réel",
    body: "L'export utilise FFmpeg réel sur votre média local : 1080×1920, H.264, AAC, sous-titres ASS mot-à-mot brûlés, avec vérification ffprobe du fichier produit.",
  },
  {
    title: "6. Validation humaine",
    body: "Aucune publication automatique. Chaque projet reste en attente de validation humaine explicite avant toute diffusion, que vous effectuez vous-même sur la plateforme de votre choix.",
  },
];

const FEATURES = [
  {
    title: "Score explicable, pas une boîte noire",
    body: "Accroche, densité lexicale, question, émotion, changement de locuteur, durée et pénalités : chaque point du score est justifié par une raison lisible.",
  },
  {
    title: "Transcript mot-à-mot éditable",
    body: "Corrigez chaque mot, son début et sa fin, directement dans l'éditeur, avec ou sans média chargé.",
  },
  {
    title: "Safe zones & variantes de cadrage",
    body: "Visualisez les zones réservées aux sous-titres et à l'UI des plateformes, et ajustez un cadrage par variante (9:16, 1:1, 4:5, 16:9).",
  },
  {
    title: "Adaptateurs de transcription",
    body: "Architecture TranscriptProvider avec démo déterministe hors-ligne, et interfaces prêtes pour OpenAI gpt-4o-transcribe-diarize et AssemblyAI — sans clé ni appel réseau par défaut.",
  },
  {
    title: "Export FFmpeg réel",
    body: "Export vertical 1080×1920, H.264/AAC, sous-titres ASS mot-à-mot, avec vérification automatique du fichier produit via ffprobe.",
  },
  {
    title: "Validation humaine par défaut",
    body: "Aucune action de publication n'est jamais déclenchée automatiquement. Un projet reste « à valider » tant qu'un humain ne l'a pas explicitement approuvé.",
  },
];

const FAQ = [
  {
    q: "PeakCut télécharge-t-il la vidéo YouTube que je colle ?",
    a: "Non. L'endpoint de validation ne fait que vérifier la forme de l'URL (domaine, identifiant de vidéo). Aucun téléchargement, aucun appel à l'API YouTube, aucune donnée envoyée à un tiers.",
  },
  {
    q: "Le score prédit-il le nombre de vues ou le temps de visionnage ?",
    a: "Non, jamais. C'est un score éditorial explicable basé sur des heuristiques transparentes (accroche, densité lexicale, question, émotion, changement de locuteur, durée, pénalités). Ce n'est ni un temps de visionnage estimé, ni une garantie de viralité.",
  },
  {
    q: "Qui décide de publier un extrait ?",
    a: "Vous, uniquement. PeakCut ne publie rien automatiquement sur aucune plateforme. Chaque projet reste au statut « à valider » jusqu'à une approbation humaine explicite.",
  },
  {
    q: "Ai-je le droit d'extraire des passages d'une vidéo qui ne m'appartient pas ?",
    a: "Non, pas sans autorisation. Vous restez seul responsable du respect du droit d'auteur et des conditions d'utilisation de la source. PeakCut est un outil d'édition, pas une autorisation légale.",
  },
  {
    q: "Des clés API sont-elles stockées dans le code ?",
    a: "Non. Les adaptateurs OpenAI et AssemblyAI lisent leur clé depuis l'environnement au moment de l'appel et échouent explicitement si elle est absente. Aucun secret n'est committé.",
  },
];

export default async function Home() {
  const demoProject = await buildDemoProject();

  return (
    <>
      <header className="border-b border-white/5">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
          <span className="text-lg font-semibold tracking-tight">
            Peak<span className="text-amber-400">Cut</span>
          </span>
          <nav aria-label="Navigation principale" className="hidden gap-6 text-sm text-zinc-400 sm:flex">
            <a href="#comment-ca-marche" className="hover:text-zinc-100">
              Comment ça marche
            </a>
            <a href="#fonctionnalites" className="hover:text-zinc-100">
              Fonctionnalités
            </a>
            <a href="#demo" className="hover:text-zinc-100">
              Démo
            </a>
            <a href="#faq" className="hover:text-zinc-100">
              FAQ
            </a>
          </nav>
        </div>
      </header>

      <main className="flex-1">
        <section className="relative overflow-hidden px-6 py-20 sm:py-28">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_top,_rgba(251,191,36,0.12),_transparent_60%)]"
          />
          <div className="mx-auto max-w-3xl text-center">
            <p className="mb-4 inline-block rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-zinc-400">
              Édition assistée, validation 100% humaine
            </p>
            <h1 className="text-4xl font-bold tracking-tight text-zinc-50 sm:text-5xl">
              Repérez vos meilleurs moments,{" "}
              <span className="text-amber-400">gardez la main sur ce qui sort.</span>
            </h1>
            <p className="mx-auto mt-5 max-w-xl text-balance text-zinc-400">
              PeakCut analyse une vidéo, propose des segments courts avec un score éditorial
              explicable, et vous laisse corriger texte, timing et cadrage avant tout export. Rien
              n&apos;est publié sans votre validation.
            </p>
            <div className="mt-8 flex justify-center">
              <YoutubeUrlForm />
            </div>
          </div>
        </section>

        <section className="border-t border-white/5 bg-white/[0.02] px-6 py-6">
          <div className="mx-auto max-w-3xl text-center text-xs text-zinc-500">
            <strong className="text-zinc-300">Avertissement droits d&apos;auteur :</strong> vous êtes
            seul·e responsable de disposer des droits nécessaires sur la vidéo source. PeakCut ne
            vérifie pas la titularité des droits et n&apos;autorise aucun usage. Mode validation
            humaine activé par défaut : aucun export n&apos;est publié automatiquement.
          </div>
        </section>

        <section id="comment-ca-marche" className="px-6 py-20">
          <div className="mx-auto max-w-6xl">
            <h2 className="text-center text-2xl font-bold text-zinc-50 sm:text-3xl">
              Comment ça marche
            </h2>
            <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {STEPS.map((step) => (
                <div
                  key={step.title}
                  className="rounded-2xl border border-white/10 bg-zinc-900/50 p-5"
                >
                  <h3 className="font-semibold text-amber-300">{step.title}</h3>
                  <p className="mt-2 text-sm text-zinc-400">{step.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="fonctionnalites" className="border-t border-white/5 px-6 py-20">
          <div className="mx-auto max-w-6xl">
            <h2 className="text-center text-2xl font-bold text-zinc-50 sm:text-3xl">
              Fonctionnalités
            </h2>
            <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {FEATURES.map((f) => (
                <div key={f.title} className="rounded-2xl border border-white/10 bg-zinc-900/50 p-5">
                  <h3 className="font-semibold text-zinc-100">{f.title}</h3>
                  <p className="mt-2 text-sm text-zinc-400">{f.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="demo" className="border-t border-white/5 px-6 py-20">
          <div className="mx-auto max-w-6xl">
            <div className="mb-10 text-center">
              <h2 className="text-2xl font-bold text-zinc-50 sm:text-3xl">
                Studio — importez un média local ou explorez la démo
              </h2>
              <p className="mx-auto mt-3 max-w-2xl text-sm text-zinc-400">
                Importez un fichier local (aperçu HTML5 immédiat, aucun envoi tant que vous ne
                cliquez pas sur « Importer ») ou lancez l&apos;analyse déterministe hors-ligne pour
                remplacer les segments de démonstration. Modifiez le texte, les bornes ou le
                cadrage : le score se recalcule en direct, localement.
              </p>
            </div>
            <StudioSection initialProject={demoProject} />
          </div>
        </section>

        <section id="faq" className="border-t border-white/5 px-6 py-20">
          <div className="mx-auto max-w-3xl">
            <h2 className="text-center text-2xl font-bold text-zinc-50 sm:text-3xl">
              Questions fréquentes
            </h2>
            <dl className="mt-10 space-y-6">
              {FAQ.map((item) => (
                <div key={item.q} className="border-b border-white/10 pb-6">
                  <dt className="font-semibold text-zinc-100">{item.q}</dt>
                  <dd className="mt-2 text-sm text-zinc-400">{item.a}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>
      </main>

      <footer className="border-t border-white/5 px-6 py-10">
        <div className="mx-auto max-w-6xl flex flex-col gap-3 text-xs text-zinc-500 sm:flex-row sm:items-center sm:justify-between">
          <p>
            PeakCut — outil d&apos;édition. Aucune clé API n&apos;est stockée dans ce code. Aucune
            publication externe n&apos;est jamais déclenchée automatiquement.
          </p>
          <p>Validation humaine obligatoire avant toute diffusion.</p>
        </div>
      </footer>
    </>
  );
}
