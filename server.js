require("dotenv").config();
const express = require("express");
const path = require("path");
const { GoogleGenAI } = require("@google/genai");

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

const RIOT_API_KEY = process.env.RIOT_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";

const ai = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;

const PLATFORM_TO_REGION = {
  euw1: "europe", eun1: "europe", tr1: "europe", ru: "europe",
  na1: "americas", br1: "americas", la1: "americas", la2: "americas",
  kr: "asia", jp1: "asia",
};

function safeNumber(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function formatDuration(seconds) {
  const s = safeNumber(seconds);
  const min = Math.floor(s / 60);
  const sec = s % 60;
  return `${min}m${String(sec).padStart(2, "0")}s`;
}

function getQueueLabel(queueId) {
  const queues = {
    400: { label: "NORMAL DRAFT", type: "Normal" },
    430: { label: "NORMAL BLIND", type: "Normal" },
    490: { label: "QUICKPLAY", type: "Normal" },
    420: { label: "SOLOQ", type: "SoloQ" },
    440: { label: "FLEX", type: "Flexible" },
    450: { label: "ARAM", type: "ARAM" },
  };
  return queues[queueId] || { label: `QUEUE ${queueId}`, type: "Autre" };
}

async function riotFetch(url) {
  if (!RIOT_API_KEY) {
    const err = new Error("RIOT_API_KEY manquante sur Render");
    err.status = 500;
    throw err;
  }

  const res = await fetch(url, { headers: { "X-Riot-Token": RIOT_API_KEY } });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  if (!res.ok) {
    const err = new Error(data.status?.message || `Riot API error ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

app.get("/api/account", async (req, res) => {
  try {
    const { gameName, tagLine, platform = "euw1" } = req.query;
    if (!gameName || !tagLine) return res.status(400).json({ error: "gameName et tagLine requis" });
    const region = PLATFORM_TO_REGION[platform] || "europe";
    const data = await riotFetch(`https://${region}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`);
    res.json(data);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.get("/api/matches", async (req, res) => {
  try {
    const { puuid, platform = "euw1", count = 10 } = req.query;
    if (!puuid) return res.status(400).json({ error: "puuid requis" });
    const region = PLATFORM_TO_REGION[platform] || "europe";
    const data = await riotFetch(`https://${region}.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids?start=0&count=${count}`);
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
    const data = await riotFetch(`https://${region}.api.riotgames.com/lol/match/v5/matches/${matchId}`);
    res.json(data);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

function compactParticipant(p) {
  const gameSeconds = safeNumber(p.gameEndedInEarlySurrender ? 0 : undefined);
  return {
    champion: p.championName,
    role: p.teamPosition || p.individualPosition || "UNKNOWN",
    win: p.win,
    kda: `${p.kills}/${p.deaths}/${p.assists}`,
    kills: p.kills,
    deaths: p.deaths,
    assists: p.assists,
    cs: (p.totalMinionsKilled || 0) + (p.neutralMinionsKilled || 0),
    gold: p.goldEarned,
    damageToChampions: p.totalDamageDealtToChampions,
    damageTaken: p.totalDamageTaken,
    visionScore: p.visionScore,
    wardsPlaced: p.wardsPlaced,
    wardsKilled: p.wardsKilled,
    controlWardsBought: p.visionWardsBoughtInGame,
    towersDestroyed: p.turretKills || p.turretsKilled || 0,
    inhibitorsDestroyed: p.inhibitorKills || 0,
    summoners: [p.summoner1Id, p.summoner2Id],
    items: [p.item0, p.item1, p.item2, p.item3, p.item4, p.item5, p.item6].filter(Boolean),
    level: p.champLevel,
  };
}

function buildStatsBlock({ rank, role, queueLabel, queueType, matchData }) {
  const p = matchData.participant;
  const durationMin = safeNumber(matchData.gameDuration) / 60;
  const cs = (p.totalMinionsKilled || 0) + (p.neutralMinionsKilled || 0);
  const csPerMin = durationMin ? (cs / durationMin).toFixed(1) : "0.0";
  const dpm = durationMin ? Math.round((p.totalDamageDealtToChampions || 0) / durationMin) : 0;
  const gpm = durationMin ? Math.round((p.goldEarned || 0) / durationMin) : 0;
  const teamKills = (matchData.participant?.teamId ? matchData.alliesFull || [] : [])
    .reduce((sum, player) => sum + (player.kills || 0), p.kills || 0);
  const kp = teamKills > 0 ? Math.round(((p.kills + p.assists) / teamKills) * 100) : null;
  const queue = queueLabel || getQueueLabel(matchData.queueId).label;

  const allies = (matchData.team || []).map(t => t.championName).join(", ");
  const enemies = (matchData.enemies || []).map(e => e.championName).join(", ");

  return `Type de partie: ${queueType || "Non précisé"} (${queue})
Rang déclaré: ${rank}
Rôle déclaré: ${role}
Champion: ${p.championName}
Résultat: ${p.win ? "Victoire" : "Défaite"}
Durée: ${formatDuration(matchData.gameDuration)}
KDA: ${p.kills}/${p.deaths}/${p.assists}
CS: ${cs} (${csPerMin}/min)
Gold: ${p.goldEarned} (${gpm}/min)
Dégâts champions: ${p.totalDamageDealtToChampions} (${dpm}/min)
Dégâts subis: ${p.totalDamageTaken}
Vision: ${p.visionScore}, wards posées: ${p.wardsPlaced}, wards détruites: ${p.wardsKilled}, pinks achetées: ${p.visionWardsBoughtInGame}
Tours détruites: ${p.turretKills || p.turretsKilled || 0}, inhibiteurs: ${p.inhibitorKills || 0}
Kill participation estimée: ${kp !== null ? kp + "%" : "non calculable"}
Items IDs: ${[p.item0,p.item1,p.item2,p.item3,p.item4,p.item5,p.item6].filter(Boolean).join(", ") || "non fourni"}
Équipe alliée: ${allies || "non fourni"}
Équipe adverse: ${enemies || "non fourni"}`;
}

function buildCoachPrompt({ rank, role, queueType, queueLabel, matchData, context }) {
  const p = matchData.participant;
  const statsBlock = buildStatsBlock({ rank, role, queueType, queueLabel, matchData });

  return `Tu es un coach professionnel League of Legends niveau Challenger, spécialisé SoloQ.

Mission : générer une review express compacte, critique et actionnable à partir des données Riot API.
Tu n'es PAS un commentateur OP.GG. Tu dois pointer les erreurs probables et donner des corrections concrètes.

Profil :
- Rang : ${rank || "Non précisé"}
- Rôle : ${role || "Non précisé"}
- Champion : ${p.championName}
- Type de game : ${queueLabel || queueType || "Non précisé"}

Données Riot :
"""
${statsBlock}
"""

Ressenti joueur :
"""
${context || "aucun ressenti donné"}
"""

Règles strictes :
- Tu n'as pas vu la VOD : n'invente aucun timing, fight précis ou action non prouvée.
- Chaque axe doit commencer par une ERREUR probable contrôlable par le joueur.
- Si la game est gagnée, critique quand même : fermeture de game, conversion d'avance, tempo, régularité.
- Si la game est perdue, priorise l'erreur la plus contrôlable : deaths, wave, reset, vision, fight selection, objectif.
- Maximum 20% lecture de stats, 80% corrections concrètes.
- Ne commente que 3 signaux clés.
- Texte court, direct, dur mais utile.
- Adapte au rôle ${role || "Non précisé"}.
- SoloQ : focus autonomie, LP, tempo individuel, erreurs punissables.
- Flex : focus coordination, objectifs, exécution collective.
- Normal : focus apprentissage et mauvaises habitudes.

Priorités par rôle :
Top = waves, trades, side lane, TP, pression, morts sur gank.
Jungle = clear, pathing, tracking, objectifs, conversion kill -> objectif.
Mid = prio, roam après push, influence jungle/sides, deaths évitables.
ADC = farm utile, resets, mid game waves, DPS sans mourir, spacing, objectifs.
Support = vision avant objectif, roam timing, protection carry, engage/disengage.

Réponds UNIQUEMENT en JSON valide. Aucun markdown. Aucun texte autour.
Format compact exact :
{
  "diagnostic": {"title":"2 à 4 mots","text":"Diagnostic critique en 2 phrases max."},
  "signals": [
    {"label":"Stat","value":"Valeur","text":"Ce que ça révèle en 1 phrase."},
    {"label":"Stat","value":"Valeur","text":"Ce que ça révèle en 1 phrase."},
    {"label":"Stat","value":"Valeur","text":"Ce que ça révèle en 1 phrase."}
  ],
  "mainProblem": {"title":"Problème principal","text":"Pourquoi c'est prioritaire en 2 phrases max."},
  "axes": [
    {"title":"Titre court","mistake":"Erreur probable en 1 phrase.","whyBad":"Pourquoi ça coûte cher en 1 phrase.","fix":"Correction concrète en 1 phrase."},
    {"title":"Titre court","mistake":"Erreur probable en 1 phrase.","whyBad":"Pourquoi ça coûte cher en 1 phrase.","fix":"Correction concrète en 1 phrase."},
    {"title":"Titre court","mistake":"Erreur probable en 1 phrase.","whyBad":"Pourquoi ça coûte cher en 1 phrase.","fix":"Correction concrète en 1 phrase."}
  ],
  "plan": {"early":"0-10 min : 1 consigne.","mid":"10-20 min : 1 consigne.","late":"20+ min : 1 consigne."},
  "exercise": {"title":"Nom court","goal":"Objectif mesurable sur 3 games."},
  "coachLine":"Phrase coach courte."
}

Contraintes :
- signals = exactement 3.
- axes = exactement 3.
- Pas de champ vide.
- Phrases courtes.
- Pas d'exemple long.
- Pas de liste dans les valeurs.
- Termine toujours le JSON. Toutes les accolades doivent être fermées.`;
}

function extractJson(text) {
  const raw = String(text || "").trim();
  try { return JSON.parse(raw); } catch {}

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) {
    try { return JSON.parse(fenced[1]); } catch {}
  }

  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    try { return JSON.parse(raw.slice(first, last + 1)); } catch {}
  }

  return null;
}

function fallbackStructuredReview(text) {
  return {
    diagnostic: {
      title: "Review brute",
      text: "L'analyse a été générée, mais le format JSON n'a pas été parfaitement respecté. La version brute reste disponible."
    },
    signals: [],
    mainProblem: {
      title: "Format incomplet",
      text: "Relancer l'analyse peut corriger l'affichage en cartes."
    },
    axes: [],
    plan: { early: "", mid: "", late: "" },
    exercise: null,
    coachLine: "Review brute disponible ci-dessous.",
    raw: String(text || "")
  };
}

app.post("/api/analyze", async (req, res) => {
  try {
    if (!ai) return res.status(500).json({ error: "GEMINI_API_KEY manquante sur Render" });

    const { rank, role, queueType, queueLabel, queueId, matchData, context } = req.body;
    if (!matchData || !matchData.participant) {
      return res.status(400).json({ error: "matchData.participant requis" });
    }

    matchData.queueId = matchData.queueId || queueId;
    const prompt = buildCoachPrompt({ rank, role, queueType, queueLabel, matchData, context });

    const geminiRes = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt,
      config: {
        temperature: 0.3,
        maxOutputTokens: 900,
        responseMimeType: "application/json",
      },
    });

    const text = geminiRes.text || "";
    const parsed = extractJson(text) || fallbackStructuredReview(text);

    // Compatibilité front V2 : on garde analysis, et on ajoute review pour la suite.
    res.json({ analysis: parsed, review: parsed, raw: text });
  } catch (e) {
    const rawMessage = e?.message || "Erreur Gemini";
    const message = String(rawMessage);

    if (message.includes("503") || message.includes("UNAVAILABLE") || message.includes("high demand")) {
      return res.status(503).json({
        error: "Gemini est temporairement surchargé. Attends 30 secondes puis relance l’analyse."
      });
    }

    if (message.includes("429") || message.includes("RESOURCE_EXHAUSTED") || message.includes("quota")) {
      return res.status(429).json({
        error: "Quota Gemini atteint ou temporairement limité. Réessaie plus tard."
      });
    }

    res.status(500).json({ error: message });
  }
});

app.get("/health", (req, res) => {
  res.json({ ok: true, provider: "gemini", model: GEMINI_MODEL });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Serveur lancé sur le port ${PORT}`));
