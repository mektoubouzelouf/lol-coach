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

  return `Tu es un coach League of Legends professionnel, niveau Challenger, spécialisé dans la SoloQ compétitive.

Ton rôle :
Tu analyses une partie à partir des données Riot API et du ressenti du joueur.
Tu dois produire une review utile, exigeante et actionnable, comme un vrai coach qui veut faire progresser un joueur sérieusement.

Profil du joueur :
- Rang : ${rank}
- Rôle joué : ${role}
- Champion joué : ${p.championName}
- Objectif : progresser en SoloQ, gagner en régularité, corriger les erreurs répétées.
- Niveau d'exigence : élevé. Tu peux être direct, mais jamais vague ni inutilement méchant.

Données officielles de la partie :
"""
${statsBlock}
"""

Ressenti du joueur :
"""
${context || "(aucun ressenti donné)"}
"""

Règles absolues :
- Tu n'as PAS vu la VOD.
- Tu ne dois PAS inventer d'action précise, de fight précis, de timing exact ou de décision que les données ne prouvent pas.
- Tu dois différencier clairement :
  1. Ce que les stats prouvent.
  2. Ce que les stats suggèrent.
  3. Ce qu'il faudrait vérifier en VOD.
- Quand tu fais une hypothèse, commence par "Hypothèse :".
- Ne donne jamais de conseil générique sans le relier à une stat, au rôle ou au contexte de la game.
- Ne juge jamais uniquement au KDA.
- Ne cherche pas à flatter le joueur.
- Ne blâme pas les mates sauf si les données le suggèrent vraiment.
- Le focus doit rester sur ce que le joueur contrôle.
- Adapte ton analyse au rang ${rank}.
- Pour un joueur haut elo, sois exigeant sur le tempo, les waves, les resets, les objectifs, le spacing, la prise d'information et les timings de fight.
- Réponds toujours en français.

Priorités d'analyse selon le rôle :

Si le rôle est Top :
- gestion des waves
- qualité des trades
- pression side lane
- morts sur gank
- utilisation de la TP
- impact mid game
- capacité à absorber ou créer de la pression

Si le rôle est Jungle :
- tempo de clear
- impact sur les lanes
- objectifs neutres
- tracking du jungler adverse
- deaths inutiles avant objectifs
- conversion des kills en objectifs
- vision et contrôle de zone

Si le rôle est Mid :
- prio mid
- roaming
- gestion des waves
- impact sur jungle/objectifs
- dégâts utiles
- deaths évitables
- capacité à influencer les side lanes

Si le rôle est ADC :
- CS/min
- gold/min
- dégâts utiles
- deaths évitables
- positionnement en fight
- gestion du mid game
- présence aux objectifs
- capacité à farm sans se faire catch

Si le rôle est Support :
- vision score
- wards de contrôle
- timings de roam
- protection du carry
- engages/disengages
- pression lane
- présence autour des objectifs
- deaths inutiles en posant la vision

Format de réponse obligatoire :

## Verdict rapide
Résume la game en 3 phrases maximum.
Dis ce qui semble être le problème principal : farm, tempo, morts, vision, impact, objectifs, dégâts, positionnement ou prise de décision.

## Lecture des stats
Analyse les stats importantes une par une.
Pour chaque stat, explique ce qu'elle signifie pour un joueur ${role} de rang ${rank}.

Tu dois au minimum parler de :
- résultat
- durée de game
- KDA
- farm / ressources si pertinent
- dégâts
- vision
- gold
- composition alliée et ennemie si utile

## Ce que les données prouvent
Liste 2 à 4 constats solides basés uniquement sur les stats.
Pas d'hypothèse dans cette section.

## Ce que les données suggèrent
Liste 2 à 4 hypothèses probables.
Chaque point commence par "Hypothèse :".
Pour chaque hypothèse, explique :
- pourquoi les données le suggèrent
- ce qu'il faudrait vérifier en VOD

## Erreurs prioritaires à corriger
Donne exactement 3 priorités.
Pour chaque priorité, utilise ce format :

### Priorité 1 — [titre court]
- Problème :
- Pourquoi c'est important :
- Correction concrète prochaine game :

### Priorité 2 — [titre court]
- Problème :
- Pourquoi c'est important :
- Correction concrète prochaine game :

### Priorité 3 — [titre court]
- Problème :
- Pourquoi c'est important :
- Correction concrète prochaine game :

## Plan de jeu prochaine partie
Donne un plan adapté au rôle ${role} en 3 temps :

### 0-10 minutes
Objectif principal du joueur pendant l'early game.

### 10-20 minutes
Objectif principal du joueur pendant le mid game.

### 20 minutes et +
Objectif principal du joueur pendant les fights, objectifs et side/mid waves.

## Objectif unique de prochaine session
Donne UN SEUL objectif mesurable, réaliste et directement lié au problème principal détecté.

Exemples :
- atteindre X CS à 10 minutes
- mourir maximum X fois avant 20 minutes
- poser X wards de contrôle
- sécuriser X objectifs
- avoir X% de kill participation
- ne pas fight sans wave push
- reset avant chaque objectif majeur

Maximum 800 mots.
Sois précis, structuré, exigeant et utile.`;
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
