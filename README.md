# PeakCut

PeakCut est un MVP de repurposing vidéo orienté Shorts. Il transforme un projet éditorial en segments verticaux éditables, avec transcript mot-à-mot, score explicable et export FFmpeg vérifié.

## Fonctionnalités du MVP

- Landing page française responsive, inspirée des workflows de clipping modernes, avec identité PeakCut originale.
- Validation structurelle stricte des URLs YouTube publiques (`watch`, `youtu.be`, `shorts`, `embed`) sans appel réseau.
- Téléchargement réel de la vidéo validée (yt-dlp), en job de fond, sur demande explicite dans un projet : le fichier obtenu alimente ensuite transcription, analyse, cadrage et export.
- Transcript mot-à-mot horodaté et locuteur, via un fournisseur mock déterministe hors-ligne.
- Adaptateurs préparés pour OpenAI `gpt-4o-transcribe-diarize` et AssemblyAI ; ils échouent explicitement sans configuration et n’appellent aucun service par défaut.
- Score éditorial explicable : accroche, densité lexicale, question, émotion, changement de locuteur, durée, confiance et pénalités.
- Traitement automatique en un bouton : une URL YouTube enchaîne téléchargement, transcription, découpage, classement et cadrage, étape par étape et reprenable.
- Découpage en clips candidats : le transcript est coupé en clips d’une minute (50–95 s) alignés sur des fins de phrase, classés par ce même score.
- Montage par clip, modifiable : zoom animé et style de sous-titres compilés réellement par l’export, et éditables dans le studio.
- Timeline éditable : clips placés à leur vraie position, rognage à la souris ou au clavier, découpe et suppression — avec re-découpage des sous-titres, re-score et réajustement des effets.
- Éditeur de démonstration : segments, timeline, texte et mots éditables, cadrage et safe zones pour les variantes 9:16, 1:1, 4:5 et 16:9.
- Export FFmpeg réel depuis le fichier média du projet (import local ou vidéo YouTube téléchargée) : 1080×1920, H.264, AAC, sous-titres ASS mot-à-mot et vérification ffprobe.
- Validation humaine par défaut ; aucune publication YouTube/TikTok n’est implémentée dans ce MVP.

## Installation

Pré-requis : Node.js 20+, npm et FFmpeg/FFprobe pour les tests d’intégration d’export.
Pour les jobs `download`, il faut aussi [yt-dlp](https://github.com/yt-dlp/yt-dlp) sur le `PATH`
(ou `PEAKCUT_YTDLP_PATH`). Sans lui, ces jobs échouent explicitement avec
`downloader-unavailable` — rien n’est simulé.

```bash
npm install
npm run dev
```

Ouvrir <http://localhost:3000>.

### Worker de jobs : intégré en dev, séparé en production

Les jobs lourds (téléchargement yt-dlp, transcription, analyse, cadrage, export
FFmpeg) ne sont jamais exécutés dans le cycle HTTP : une route met en file, un
worker réclame et exécute.

En développement, `npm run dev` démarre ce worker **dans le serveur Next.js**
(via `src/instrumentation.ts`) : il n’y a rien à lancer à côté. En production il
reste dans son propre process (`npm run worker`, voir
`deploy/peakcut-worker.service`) : un render de plusieurs minutes ne doit pas
partager la politique de redémarrage du serveur qui sert les requêtes.

`PEAKCUT_INLINE_WORKER` force le choix, dans les deux sens :

| Valeur | Effet |
| --- | --- |
| absente | worker intégré hors production, séparé en production |
| `1` | worker intégré, production comprise (déploiement mono-instance) |
| `0` | jamais intégré ; il faut lancer `npm run worker` |

Les deux modes peuvent tourner ensemble sans risque : `claimNextJob()` réclame
dans une transaction `BEGIN IMMEDIATE`, donc deux workers ne prennent jamais la
même ligne.

À savoir en dev : la boucle est démarrée une fois, au lancement du serveur, et
garde les modules chargés à ce moment-là. Le HMR de `next dev` ne la rejoue pas,
donc **une modification d'un handler de job (ou de ce qu'il appelle) demande un
redémarrage du serveur** — sinon le worker continue d'exécuter l'ancien code
alors que les routes HTTP servent déjà le nouveau.

### Optionnel : détection de visage locale (venv Python)

Le fournisseur de cadrage `local-subject` peut s’appuyer sur un vrai détecteur
de visage OpenCV (`scripts/vision/track_faces.py`, cascade de Haar frontale
intégrée à OpenCV — aucun modèle téléchargé, aucun réseau). C’est **optionnel** :
sans cette installation, `local-subject` répond explicitement « indisponible »
plutôt que de fabriquer un faux résultat, et le repli `stable-center-fallback`
(cadrage centré, sans détection) reste toujours utilisable.

```bash
python3 -m venv .venv-vision
source .venv-vision/bin/activate       # Windows : .venv-vision\Scripts\activate
pip install -r requirements-vision.txt
```

**Le worker tourne dans le serveur Next en développement et hérite de son
`PATH` au démarrage** : activer le venv dans un autre terminal ne lui donne
donc pas accès à OpenCV. Pointez explicitement son interpréteur, puis
redémarrez le serveur :

```bash
# .env.local — un chemin de fichier, jamais un secret
PEAKCUT_PYTHON_BINARY=/chemin/vers/.venv-vision/bin/python
# Windows : A:\chemin\vers\.venv-vision\Scripts\python.exe
```

Aucune clé ni secret n’est nécessaire : la détection tourne entièrement en
local. Le venv (`.venv-vision/`) ne doit jamais être commité (couvert par
`.gitignore`).

La détection décode les images **via FFmpeg** (déjà requis par l’export) et
fait tourner la cascade sur une copie réduite à 480 px de large. Ce n’est pas
une micro-optimisation : décoder chaque image avec OpenCV et détecter en
pleine résolution demandait 17 minutes sur une source 1080p60 de 10 minutes,
contre ~35 s ainsi — l’ancien plafond de 20 s du moteur ne laissait donc
jamais aboutir la moindre vidéo longue. `PEAKCUT_TRACKING_TIMEOUT_MS` borne
l’exécution (15 minutes par défaut).

Vous pouvez aussi brancher votre propre moteur de détection externe (tout
langage) via la variable d’environnement `PEAKCUT_TRACKER_COMMAND` (chemin
vers un exécutable local) ; si elle est définie, elle a priorité sur OpenCV.
Le programme reçoit `<mediaPath> <largeur> <hauteur> <duréeSec>` en argv et
répond en JSON sur la sortie standard.

Un tracker écrit en Python ou en Node n’est pas lui-même un exécutable : c’est
un argument passé à un interpréteur. `PEAKCUT_TRACKER_ARGS` porte ces
arguments fixes, insérés avant ceux du média, sous forme de **tableau JSON de
chaînes** — jamais une ligne de commande à découper, donc aucune citation à
interpréter et aucun moyen qu’une valeur se transforme en argument
supplémentaire :

```bash
PEAKCUT_TRACKER_COMMAND=/usr/bin/python3
PEAKCUT_TRACKER_ARGS=["/chemin/vers/mon_tracker.py","--model","fast"]
```

Sur Windows c’est la seule forme utilisable : le shebang `#!/usr/bin/env python`
n’y existe pas, et un `.cmd` d’enrobage est refusé par `spawn()` sans shell
(correctif Node CVE-2024-27980). Ces deux variables ne contiennent que des
chemins et des options, jamais un secret : le processus lancé ne reçoit que
`PATH`.

## Transcription réelle

Transcrire un projet exige un fournisseur réel : renseignez une clé et
redémarrez le serveur.

| Fournisseur | Variable | Modèle |
| --- | --- | --- |
| OpenAI | `OPENAI_API_KEY` | `gpt-4o-transcribe-diarize`, `response_format: diarized_json` |
| AssemblyAI | `ASSEMBLYAI_API_KEY` | upload puis transcription avec `speaker_labels` |

Sans la variable, le fournisseur s'affiche « (non configuré) », le bouton de
transcription reste désactivé et un appel direct à l'API échoue explicitement.

`MockTranscriptProvider` ne fait **pas** partie du registre : il renvoie toujours
le même script de démonstration quel que soit le média, ce qui convient à la
démonstration de la page d'accueil (construite directement dessus par
`analyzeMockTranscript`) mais serait un piège sur un vrai projet — le transcript
n'aurait aucun rapport avec la vidéo, et le scoring, les segments et les
sous-titres incrustés en découleraient tous. Rien de ce que propose le registre
ne fabrique de transcript.

### Médias longs

L'endpoint OpenAI refuse tout fichier au-delà de 25 Mio, ce qu'une vidéo de
quelques minutes en 1080p dépasse largement. Au-dessus de cette taille, PeakCut
extrait d'abord la piste audio avec FFmpeg (mono, 16 kHz, 64 kbit/s, soit
environ 8 ko par seconde) et envoie ce fichier-là ; en dessous, le fichier
d'origine part tel quel, sans ré-encodage et sans dépendre de FFmpeg. Si l'audio
extrait dépasse encore la limite — environ 50 minutes d'enregistrement — la
transcription échoue explicitement plutôt que d'envoyer un fichier tronqué et de
rendre un transcript qui s'arrête en route.

`PEAKCUT_TRANSCRIPT_TIMEOUT_MS` borne la requête au fournisseur (10 minutes par
défaut, ce qui couvre l'upload et le traitement d'un média long).

## Découpage en clips candidats

L’analyse ne note plus la vidéo entière comme un bloc unique : elle propose
plusieurs clips candidats, découpés depuis le transcript par
`src/lib/analysis/segmentTranscript.ts`. Trois règles les façonnent :

1. **Les bornes tombent sur des fins de phrase**, jamais au milieu d’une
   proposition — un clip qui s’ouvre en plein milieu d’une phrase est
   inutilisable quel que soit son score, donc ces fenêtres ne sont même pas
   construites.
2. **Les durées visent la minute** (plateau 50–95 s, défini une seule fois
   dans `src/lib/domain/shortFormDuration.ts`), exactement l’intervalle où le
   facteur de durée du scorer vaut 1. Le générateur et le scorer s’accordent
   donc sur ce qu’est une « longueur de format court », au lieu que l’un
   propose ce que l’autre pénalise. Le plateau est plus large que la cible
   parce que les bornes tombent sur des fins de phrase : une fenêtre trop
   étroite ne contiendrait souvent aucune coupe légale, et le moment serait
   purement et simplement perdu.
3. **Les candidats retenus ne se chevauchent pas** : sinon un moment fort
   remplirait toute la liste de quasi-doublons de lui-même et enterrerait
   tout le reste de la vidéo.

C’est un **sélecteur, pas un modèle** : il indique où un monteur humain doit
regarder en premier, il ne décide de rien. Chaque candidat porte la même
explication de score traçable qu’un segment tracé à la main, et le classement
n’est rien d’autre que ce score trié — il n’existe nulle part de notion
cachée et séparée d’« intéressant ».

Relancer l’analyse **rescore les segments existants** sans jamais les
re-découper : une retouche manuelle n’est pas perdue en appuyant deux fois sur
le bouton. Pour re-couper depuis le transcript, il faut le demander
explicitement — bouton « Re-découper depuis le transcript » dans le studio, ou
`payload.resegment: true` sur le job d’analyse — et cela remplace les segments
en place.

## D’une URL aux clips : le traitement automatique

Bouton **« Tout lancer »** dans le studio : coller une URL YouTube suffit, le
reste s’enchaîne jusqu’aux clips cadrés et sous-titrés.

Ce n’est pas un job géant, c’est la file existante enchaînée
(`src/lib/jobs/chain.ts`) : `download → transcription → analysis → tracking`.
Chaque étape est un job à part entière, et le worker met le suivant en file
quand le précédent a réussi.

| Conséquence | Pourquoi ça compte |
| --- | --- |
| Reprises granulaires | Une transcription qui échoue rejoue la transcription, pas les 400 Mo de téléchargement qui la précèdent. |
| Avancement lisible | Le studio affiche les étapes réelles avec leur progression, pas une barre opaque à 40 % pendant dix minutes. |
| L’échec arrête la ligne | Rien en aval n’est mis en file : jamais de clips découpés depuis un transcript qui n’a pas été produit. |
| Durable | Les étapes restantes vivent dans la ligne du job : un worker redémarré reprend le pipeline. |

La chaîne est **toujours construite côté serveur** : l’API accepte
`pipeline: { providerId, trackProvider, resegment }` et refuse un
`payload.__chain` fourni par le client — sinon un appelant pourrait faire
exécuter par le worker des jobs qui ne repassent pas par les contrôles de
propriété et de quota de la route. Pour la même raison, l’enchaînement n’est
pas offert pendant l’essai public, dont les quotas se comptent job par job.

Le rendu (`render`) ne fait **pas** partie de la chaîne : exporter chaque
candidat coûterait des minutes de FFmpeg sur des coupes que le monteur n’a pas
encore regardées — et l’intérêt de l’éditeur est justement qu’il les change
d’abord.

## Effets : un montage par clip, modifiable

Chaque segment porte son propre plan de rendu (`segment.renderPlan`, voir
`src/lib/effects/`) : images clés de zoom, style de sous-titres, coupes. C’est
le document éditable derrière « l’outil a fait le montage ».

- L’analyse l’initialise en lisant **un** fait du transcript : si quelqu’un
  d’autre parle dans le clip, le modèle `speaker-focus` place ses punchs sur
  les changements de locuteur ; sinon `subtle-punch` fait une poussée lente.
  Rien n’est deviné sur la performance à venir.
- Le panneau « Effets du clip » du studio permet de changer de modèle, de
  doser la force du zoom, la couleur et la taille des sous-titres.
- L’export **compile ce plan tel quel** (`crop` animé par expression FFmpeg,
  sous-titres ASS stylés) et l’aperçu applique le même traitement en basse
  résolution : ce qui est affiché est ce que contiendra le fichier.
- Toutes les valeurs sont bornées et **revalidées côté serveur** à
  l’enregistrement (`validateRenderPlan`). Un plan hors bornes est refusé à la
  frontière plutôt que rogné en silence ou découvert au rendu. La liste des
  limitations, elle, n’est jamais lue depuis le client : ce que l’export ne
  fait pas est une affirmation du serveur sur lui-même.

## Timeline : rogner, couper, supprimer

Les clips sont posés sur l’axe temporel de la source — à leur vraie place, donc
les passages que personne n’a gardés se voient. Les bords se glissent à la
souris, ou se déplacent aux flèches ← → une fois la poignée sélectionnée (le
montage ne doit pas exiger une souris). Deux actions complètent le lot sur le
clip sélectionné : « Couper en deux » et « Supprimer ce clip ».

Déplacer une borne ne change **jamais** seulement deux nombres. Un segment
porte aussi la tranche de transcript incrustée en sous-titres, un score calculé
sur cette tranche et un plan d’effets exprimé en temps relatif au clip.
`src/lib/analysis/retimeSegment.ts` garde les quatre en phase :

- les mots sont **re-découpés** depuis le transcript du projet — rogner enlève
  ce qui sort, rallonger ramène ce qui rentre ;
- le score est **recalculé** pour la nouvelle durée ;
- le plan d’effets est **réajusté** (`retimeRenderPlan`) : la coupe suit le
  clip, les images clés qui tombent après la nouvelle fin sont retirées.

Ce dernier point n’est pas cosmétique : sans lui, raccourcir un clip laissait
des images clés hors de sa plage, `validateRenderPlan` refusait le plan à
l’enregistrement, et l’utilisateur restait coincé entre une retouche qu’il
venait de faire et des effets qu’il n’avait pas touchés.

## Timeline : rogner, couper, supprimer

Les clips sont posés sur l’axe temporel de la source — à leur vraie place, donc
les passages que personne n’a gardés se voient. Les bords se glissent à la
souris, ou se déplacent aux flèches ← → une fois la poignée sélectionnée (le
montage ne doit pas exiger une souris). Deux actions complètent le lot sur le
clip sélectionné : « Couper en deux » et « Supprimer ce clip ».

Déplacer une borne ne change **jamais** seulement deux nombres. Un segment
porte aussi la tranche de transcript incrustée en sous-titres, un score calculé
sur cette tranche et un plan d’effets exprimé en temps relatif au clip.
`src/lib/analysis/retimeSegment.ts` garde les quatre en phase :

- les mots sont **re-découpés** depuis le transcript du projet — rogner enlève
  ce qui sort, rallonger ramène ce qui rentre ;
- le score est **recalculé** pour la nouvelle durée ;
- le plan d’effets est **réajusté** (`retimeRenderPlan`) : la coupe suit le
  clip, les images clés qui tombent après la nouvelle fin sont retirées.

Ce dernier point n’est pas cosmétique : sans lui, raccourcir un clip laissait
des images clés hors de sa plage, `validateRenderPlan` refusait le plan à
l’enregistrement, et l’utilisateur restait coincé entre une retouche qu’il
venait de faire et des effets qu’il n’avait pas touchés.

## Export : la porte de validation humaine

`getExportBlockReasons` refuse tout rendu tant que deux conditions ne sont pas
réunies sur le projet : les droits sur la source confirmés par un humain, et
l’export explicitement autorisé. Les deux se posent d’un seul geste dans le
studio, encadré « Export MP4 » : cocher l’attestation, signer d’un nom ou d’un
email, puis « Confirmer les droits et autoriser l’export ».

La signature est du texte libre conservé tel quel dans
`workflow.rights.confirmedBy` — jamais un jeton d’authentification. Elle
accompagne l’horodatage de la confirmation, pour que le projet garde la trace
de qui a attesté quoi, et quand.

Obtenir le fichier source n’autorise donc rien par soi-même : une vidéo
YouTube téléchargée franchit `hasLocalMediaFile` comme n’importe quel import
local, et reste non exportable jusqu’à cette confirmation.

## Authentification : mode solo

Par défaut, l'app demande un compte : session locale email/mot de passe, ou
connexion Google via Auth.js, et les routes sensibles répondent `401` sans
session.

Pour une instance utilisée par une seule personne, `PEAKCUT_SOLO_USER=1`
supprime toute cette demande : chaque requête est résolue comme un unique
compte opérateur, donc `/login`, le bouton Google et la modale « un compte est
nécessaire » n'apparaissent plus et aucune route ne répond `401`. Tout passe par
un seul point de résolution (`src/lib/auth/soloMode.ts`, branché dans
`getRequestActorAsync`) : les vérifications de propriété des projets, elles,
continuent de tourner normalement.

Le compte retenu, dans cet ordre :

1. `PEAKCUT_SOLO_USER_EMAIL` s'il est défini (créé au besoin) ;
2. sinon le seul compte déjà présent en base — les projets existants restent
   donc visibles, sans migration ;
3. sinon un compte `solo@peakcut.local` créé au premier appel.

Ce compte n'a ni mot de passe ni `google_id` : c'est une identité que le serveur
attribue, pas une identité dans laquelle on peut se connecter. Repasser le flag
à 0 restaure l'authentification complète, sans rien perdre.

**À savoir avant d'exposer l'instance** : en mode solo, toute personne capable
d'atteindre le port est propriétaire de tous les projets. `next dev` écoute aussi
sur l'IP du réseau local ; pour rester sur la boucle locale, lancer
`next dev --hostname 127.0.0.1`.

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
  lib/youtube/                 # validation d’URL et téléchargement vidéo (yt-dlp)
  lib/transcript/              # interface et adaptateurs de transcription
  lib/scoring/                 # score déterministe et explications
  lib/ffmpeg/                  # ASS, export et vérification ffprobe
  lib/demo/                    # projet de démonstration
 test/                         # fixtures synthétiques et setup Vitest
```

## Téléchargement d’une source YouTube

Le téléchargement n’est jamais automatique : il est demandé explicitement, par un
utilisateur authentifié, pour un projet qu’il possède. La route valide l’URL puis met
un job `download` en file ; le worker le traite hors du cycle HTTP (intégré au serveur
en dev, `npm run worker` en production — voir plus haut).

```bash
curl -X POST http://localhost:3000/api/download-youtube \
  -H 'content-type: application/json' \
  -b 'peakcut_session=<cookie de session>' \
  -d '{"url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ","projectId":"<id>"}'
```

Garde-fous : une seule vidéo à la fois (`--no-playlist`), refus des directs, limites de
durée et de taille vérifiées **avant** de télécharger le moindre octet
(`PEAKCUT_DOWNLOAD_MAX_DURATION_SEC`, `PEAKCUT_DOWNLOAD_MAX_MB`), quota par utilisateur,
et nettoyage complet du répertoire en cas d’échec. Obtenir le fichier n’autorise rien :
l’export reste bloqué tant que les droits ne sont pas confirmés par un humain et que
l’export n’est pas explicitement autorisé.

## API de validation

```bash
curl -X POST http://localhost:3000/api/validate-youtube-url \
  -H 'content-type: application/json' \
  -d '{"url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ"}'
```

La réponse contient `videoId` et `normalizedUrl` pour une URL valide. Cette route se limite à la
forme de l’URL : elle ne télécharge rien et n’interroge pas YouTube. Le téléchargement passe
par `/api/download-youtube` ci-dessus.

## Limites et prochaines étapes

- Brancher un fournisseur de transcription nécessite une configuration de secrets côté serveur ; aucun secret ne doit être commité.
- La détection de potentiel est un score prédictif explicable, pas une mesure de watch time Analytics ni une promesse de performance.
- Le suivi de visage est réel (OpenCV, cascade de Haar). Le suivi de locuteur et d’objet, et les effets avancés, restent à intégrer derrière des adaptateurs de rendu testables.
- Le cadrage suivi vaut pour une source filmée face caméra. Sur un partage d’écran, la cascade ne trouve que la webcam incrustée et le recadrage 9:16 cadre ce visage plutôt que le contenu montré — préférez-y `stable-center-fallback`, ou un recadrage manuel.
- `gpt-4o-transcribe-diarize` renvoie des segments, pas des mots : les bornes mot-à-mot sont donc **interpolées** au prorata du nombre de caractères, et le surlignage des sous-titres dérive à l’intérieur d’un segment. L’API ne fournissant aucune confiance par mot, la valeur neutre de 0,5 est utilisée — ce qui déclenche sur chaque segment la pénalité « confiance de transcription faible » du scorer, uniformément.
- Les effets appliqués se limitent au zoom animé et au style des sous-titres. Les illustrations incrustées, les images générées par IA, les effets 3D et le ducking audio sont déclarés dans le modèle mais pas encore compilés par l’export : `renderPlan.limitations` dit précisément lesquels, sur chaque plan.
- Le cadrage suit le visage détecté mais pas **le locuteur actif** : sur un plan à deux visages, le recadrage ne bascule pas sur celui qui parle.
- Les publications officielles nécessiteront OAuth, les permissions adéquates et une validation humaine explicite.


## État du dépôt

Le dépôt est volontairement local : aucun push ni déploiement n’a été effectué.
