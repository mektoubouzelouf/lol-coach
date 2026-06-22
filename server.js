import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { GoogleGenAI } from "@google/genai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

const RIOT_API_KEY = process.env.RIOT_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";

if (!RIOT_API_KEY) {
  console.warn("⚠️ RIOT_API_KEY manquante dans les variables d'environnement.");
}

if (!GEMINI_API_KEY) {
  console.warn("⚠️ GEMINI_API_KEY manquante dans les variables d'environnement.");
}

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

const PLATFORM_TO_REGION = {
  euw1: "europe",
  eun1: "europe",
  tr1: "europe",
  ru: "europe",
  na1: "americas",
  br1: "americas",
  la1: "americas",
  la2: "americas",
  kr: "asia",
  jp1: "asia",
};

async function riotFetch(url) {
  if (!RIOT_API_KEY) {
    const err = new Error("RIOT_API_KEY manquante côté serveur.");
    err.status = 500;
    throw err;
  }

  const res = await fetch(url, {
    headers: { "X-Riot-Token": RIOT_API_KEY },
  });

  const text = await res.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    const err = new Error(data.status?.message || `Riot API error ${res.status}`);
    err.status = res.status;
    throw err;
  }

  return data;
}

function safeNumber(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function buildStatsBlock(matchData) {
  const p = matchData.participant;
  const gameDuration = safeNumber(matchData.gameDuration, 1);
  const minutes = Math.max(gameDuration / 60, 1);

  const totalCs = safeNumber(p.totalMinionsKilled) + safeNumber(p.neutralMinionsKilled);
  const csPerMin = (totalCs / minutes).toFixed(1);
  const duration = `${Math.floor(gameDuration / 60)}m${gameDuration % 60}s`;

  const items = [
    p.item0,
    p.item1,
    p.item2,
    p.item3,
    p.item4,
    p.item5,
    p.item6,
  ].filter(Boolean);

  return `Champion: ${p.championName}
Résultat: ${p.win ? "Victoire" : "Défaite"} (${duration})
KDA: ${p.kills}/${p.deaths}/${p.assists}
CS: ${totalCs} (${csPerMin}/min)
Dégâts infligés aux champions: ${safeNumber(p.totalDamageDealtToChampions).toLocaleString("fr-FR")}
Dégâts subis: ${safeNumber(p.totalDamageTaken).toLocaleString("fr-FR")}
Vision score: ${safeNumber(p.visionScore)}
Gold gagné: ${safeNumber(p.goldEarned).toLocaleString("fr-FR")}
Tourelles détruites: ${safeNumber(p.turretKills)}
Objectifs volés: ${safeNumber(p.objectivesStolen)}
Items IDs: ${items.length ? items.join(", ") : "non disponible"}
Équipe alliée: ${matchData.team.map((t) => t.championName).join(", ")}
Équipe adverse: ${matchData.enemies.map((e) => e.championName).join(", ")}`;
}

function buildCoachPrompt({ rank, role, matchData, context }) {
  const p = matchData.participant;
  const statsBlock = buildStatsBlock(matchData);

  return return `Tu es un coach professionnel League of Legends, niveau Challenger, spécialisé dans la SoloQ compétitive.

Tu n'es pas un commentateur de statistiques.
Tu es un coach : ton objectif est de transformer les données Riot API en axes de progression concrets, routines de jeu et décisions à appliquer dès la prochaine game.

Profil du joueur :
- Rang : ${rank}
- Rôle joué : ${role}
- Champion joué : ${p.championName}
- Objectif : progresser sérieusement en SoloQ.
- Niveau d'exigence : élevé.

Données Riot API :
"""
${statsBlock}
"""

Ressenti du joueur :
"""
${context || "(aucun ressenti donné)"}
"""

Règles absolues :
- Tu n'as PAS vu la VOD.
- Tu ne dois PAS inventer d'action précise, de fight précis ou de timing exact.
- Tu peux faire des hypothèses, mais elles doivent être clairement annoncées.
- Tu ne dois PAS te contenter de lire les stats.
- Chaque remarque doit mener à une correction concrète.
- Ne dis jamais seulement "améliore ton positionnement", "améliore ta vision" ou "joue mieux les objectifs".
- Tu dois expliquer COMMENT le joueur doit le faire.
- Ne flatte pas le joueur.
- Ne blâme pas les mates.
- Le focus est toujours : qu'est-ce que le joueur aurait pu mieux contrôler ?
- Adapte ton analyse au rôle ${role} et au rang ${rank}.
- Réponds en français.

Priorités selon le rôle :

Top :
- wave management
- trades courts/longs
- gestion des timings de back
- pression side lane
- morts sur gank
- TP utile
- conversion de la pression en objectifs

Jungle :
- clear et tempo
- pathing
- tracking jungle adverse
- ganks utiles vs ganks forcés
- objectifs neutres
- vision de zone
- conversion kill → objectif

Mid :
- prio mid
- wave avant roam
- impact jungle/objectifs
- punition des timings adverses
- contrôle des sides
- dégâts utiles
- morts évitables

ADC :
- farm utile
- tempo de reset
- mid game waves
- positionnement en fight
- dégâts sans mourir
- présence aux objectifs
- éviter les catches
- conversion gold → DPS utile

Support :
- pression lane
- roam timings
- vision avant objectif
- contrôle de zone
- protection du carry
- engage/disengage
- morts en posant la vision

Format obligatoire :

## Diagnostic coach
En 4 à 6 lignes, donne le vrai diagnostic de la game.
Ne fais pas un résumé neutre.
Dis clairement quel est le thème principal de progression : tempo, conversion d'avance, survie, farm, impact map, vision, objectifs, ou prise de décision.

## Ce que les stats disent vraiment
Ne commente PAS toutes les stats une par une.
Choisis uniquement les 3 à 5 signaux les plus importants.
Pour chaque signal :
- ce que ça indique
- pourquoi c'est important pour un ${role}
- ce que ça peut révéler sur le style de jeu

## Le vrai problème à travailler
Identifie UN problème principal.
Explique pourquoi c'est celui-là, même si les stats globales semblent bonnes.

Tu dois répondre sous ce format :
- Problème principal :
- Pourquoi c'est prioritaire :
- Ce que ça coûte en SoloQ :
- Ce qu'un joueur meilleur ferait différemment :

## Hypothèses à vérifier en VOD
Donne 3 hypothèses maximum.
Chaque hypothèse doit être utile pour review la VOD.

Format :
- Hypothèse :
- Pourquoi les données le suggèrent :
- Moment à vérifier en VOD :
- Question à se poser en review :

## Plan de correction
Donne exactement 3 axes d'amélioration.
Chaque axe doit être très concret.

Format obligatoire :

### Axe 1 — [titre court]
- Erreur probable :
- Correction concrète :
- Règle simple à appliquer :
- Exemple de décision en game :

### Axe 2 — [titre court]
- Erreur probable :
- Correction concrète :
- Règle simple à appliquer :
- Exemple de décision en game :

### Axe 3 — [titre court]
- Erreur probable :
- Correction concrète :
- Règle simple à appliquer :
- Exemple de décision en game :

## Plan de jeu prochaine game
Donne un plan simple en 3 phases, adapté au rôle ${role}.

### 0-10 min
Donne 2 consignes concrètes.

### 10-20 min
Donne 2 consignes concrètes.

### 20 min et +
Donne 2 consignes concrètes.

## Exercice de progression
Donne UN exercice pratique pour la prochaine session.
Il doit être mesurable et applicable sur 3 games.

Format :
- Exercice :
- Objectif chiffré :
- Comment le mesurer :
- Ce que ça doit améliorer :

## Phrase coach
Termine par une phrase courte, directe, comme un coach Challenger qui veut faire progresser le joueur.

Maximum 850 mots.
Sois précis, dur quand il faut, mais toujours utile.`;
}

app.get("/api/account", async (req, res) => {
  try {
    const { gameName, tagLine, platform = "euw1" } = req.query;

    if (!gameName || !tagLine) {
      return res.status(400).json({ error: "gameName et tagLine requis" });
    }

    const region = PLATFORM_TO_REGION[platform] || "europe";
    const data = await riotFetch(
      `https://${region}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`
    );

    res.json(data);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.get("/api/matches", async (req, res) => {
  try {
    const { puuid, platform = "euw1", count = 10 } = req.query;

    if (!puuid) {
      return res.status(400).json({ error: "puuid requis" });
    }

    const region = PLATFORM_TO_REGION[platform] || "europe";
    const data = await riotFetch(
      `https://${region}.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids?start=0&count=${count}`
    );

    res.json(data);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.get("/api/match/:matchId", async (req, res) => {
  try {
    const { matchId } = req.params;
    const { platform = "euw1" } = req.query;

    const region = PLATFORM_TO_REGION[platform] || "europe";
    const data = await riotFetch(
      `https://${region}.api.riotgames.com/lol/match/v5/matches/${matchId}`
    );

    res.json(data);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.post("/api/analyze", async (req, res) => {
  try {
    const { rank, role, matchData, context } = req.body;

    if (!GEMINI_API_KEY) {
      return res.status(500).json({ error: "GEMINI_API_KEY manquante côté serveur." });
    }

    if (!matchData?.participant) {
      return res.status(400).json({ error: "matchData.participant manquant." });
    }

    const prompt = buildCoachPrompt({ rank, role, matchData, context });

    const geminiResponse = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt,
      config: {
        temperature: 0.7,
        maxOutputTokens: 1200,
      },
    });

    const text = geminiResponse.text || "Aucune analyse générée par Gemini.";

    res.json({ analysis: text });
  } catch (e) {
    console.error("Erreur /api/analyze:", e);
    res.status(500).json({ error: e.message || "Erreur Gemini" });
  }
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    provider: "gemini",
    model: GEMINI_MODEL,
  });
});

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`Serveur lancé sur le port ${PORT}`);
});
