# PeakCut

PeakCut est un MVP de repurposing vidéo orienté Shorts. Il transforme un projet éditorial en segments verticaux éditables, avec transcript mot-à-mot, score explicable et export FFmpeg vérifié.

## Fonctionnalités du MVP

- Landing page française responsive, inspirée des workflows de clipping modernes, avec identité PeakCut originale.
- Validation structurelle stricte des URLs YouTube publiques (`watch`, `youtu.be`, `shorts`, `embed`) sans appel réseau.
- Transcript mot-à-mot horodaté et locuteur, via un fournisseur mock déterministe hors-ligne.
- Adaptateurs préparés pour OpenAI `gpt-4o-transcribe-diarize` et AssemblyAI ; ils échouent explicitement sans configuration et n’appellent aucun service par défaut.
- Score éditorial explicable : accroche, densité lexicale, question, émotion, changement de locuteur, durée, confiance et pénalités.
- Éditeur de démonstration : segments, timeline, texte et mots éditables, cadrage et safe zones pour les variantes 9:16, 1:1, 4:5 et 16:9.
- Export FFmpeg réel depuis un média local : 1080×1920, H.264, AAC, sous-titres ASS mot-à-mot et vérification ffprobe.
- Validation humaine par défaut ; aucune publication YouTube/TikTok n’est implémentée dans ce MVP.

## Installation

Pré-requis : Node.js 20+, npm et FFmpeg/FFprobe pour les tests d’intégration d’export.

```bash
npm install
npm run dev
```

Ouvrir <http://localhost:3000>.

### Optionnel : détection de visage locale (venv Python)

Le fournisseur de cadrage `local-subject` peut s’appuyer sur un vrai détecteur
de visage OpenCV (`scripts/vision/track_faces.py`, cascade de Haar frontale
intégrée à OpenCV — aucun modèle téléchargé, aucun réseau). C’est **optionnel** :
sans cette installation, `local-subject` répond explicitement « indisponible »
plutôt que de fabriquer un faux résultat, et le repli `stable-center-fallback`
(cadrage centré, sans détection) reste toujours utilisable.

```bash
python3 -m venv .venv-vision
source .venv-vision/bin/activate
pip install -r requirements-vision.txt
```

Aucune clé ni secret n’est nécessaire : la détection tourne entièrement en
local. Le venv (`.venv-vision/`) ne doit jamais être commité (déjà couvert par
les règles usuelles d’ignore de `venv`/`.venv*`).

Vous pouvez aussi brancher votre propre moteur de détection externe (tout
langage) via la variable d’environnement `PEAKCUT_TRACKER_COMMAND` (chemin
vers un exécutable local) ; si elle est définie, elle a priorité sur OpenCV.
Cette variable ne contient qu’un chemin de fichier, jamais un secret.

## Vérification

```bash
npm test       # suite complète, dont tests d'intégration réels FFmpeg/ffprobe et OpenCV (auto-skip si OpenCV absent)
npm run lint
npm run build
```

Les tests d’intégration génèrent une courte vidéo synthétique, exportent un
Short et vérifient réellement ses dimensions, codecs, audio et lisibilité via
`ffprobe`. Le test d’intégration OpenCV s’auto-désactive proprement si le venv
vision n’est pas installé (voir ci-dessus) — aucun média ou secret externe
n’est requis pour faire passer la suite.

## Structure

```text
src/
  app/                         # page, styles et route API YouTube
  components/                  # formulaire URL et éditeur de démonstration
  lib/domain/                  # types de projet et d’édition
  lib/youtube/                 # validation structurelle d’URL
  lib/transcript/              # interface et adaptateurs de transcription
  lib/scoring/                 # score déterministe et explications
  lib/ffmpeg/                  # ASS, export et vérification ffprobe
  lib/demo/                    # projet de démonstration
 test/                         # fixtures synthétiques et setup Vitest
```

## API de validation

```bash
curl -X POST http://localhost:3000/api/validate-youtube-url \
  -H 'content-type: application/json' \
  -d '{"url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ"}'
```

La réponse contient `videoId` et `normalizedUrl` pour une URL valide. Cette route ne télécharge pas la vidéo et n’interroge pas YouTube.

## Limites et prochaines étapes

- Brancher un fournisseur de transcription nécessite une configuration de secrets côté serveur ; aucun secret ne doit être commité.
- La détection de potentiel est un score prédictif explicable, pas une mesure de watch time Analytics ni une promesse de performance.
- Le suivi visage/locuteur/objet et les effets avancés restent à intégrer derrière des adaptateurs de rendu testables.
- Les publications officielles nécessiteront OAuth, les permissions adéquates et une validation humaine explicite.


## État du dépôt

Le dépôt est volontairement local : aucun push ni déploiement n’a été effectué.
