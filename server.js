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

  return `Tu es un coach League of Legends expert, spécialisé dans le coaching de joueurs ${rank}.
Le joueur joue au poste ${role}. Il veut progresser sérieusement et obtenir des conseils exploitables.

Données officielles de la partie via l'API Riot :
"""
${statsBlock}
"""

Ressenti du joueur :
"""
${context || "(aucun ressenti donné)"}
"""

Consignes strictes :
- Réponds en français.
- Sois direct, utile, exigeant, mais pas insultant.
- Ne prétends pas avoir vu la VOD : tu n'as que les statistiques Riot et le ressenti du joueur.
- Quand tu déduis quelque chose depuis les stats, formule-le comme une hypothèse probable.
- Focus sur ce que le joueur contrôle vraiment.
- Adapte les remarques au rôle ${role}, au champion ${p.championName}, et au rang ${rank}.
- Identifie 2 à 4 problèmes concrets et actionnables.
- Pour chaque problème : explique pourquoi c'est important et quoi faire différemment.
- Termine par UN SEUL objectif mesurable pour la prochaine session.
- Maximum 450 mots.

Structure attendue :
## Lecture rapide
## Erreurs probables
## Ce qu'il faut changer
## Objectif prochaine session`;
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
