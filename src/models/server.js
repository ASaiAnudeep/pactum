const polka = require('polka');

const Interaction = require('./interaction');

const helper = require('../helpers/helper');
const store = require('../helpers/store');
const log = require('../helpers/logger');
const config = require('../config');

class Server {

  constructor() {
    this.app = null;
    this.mockInteractions = new Map();
    this.pactInteractions = new Map();
  }

  start() {
    log.trace(`Starting mock server on port ${config.mock.port}`);
    return new Promise((resolve) => {
      if (!this.app) {
        this.app = polka();
        this.app.use(bodyParser);
        registerPactumRemoteRoutes(this);
        registerAllRoutes(this, this.app);
        this.app.listen(config.mock.port, () => {
          log.info(`Mock server is listening on port ${config.mock.port}`);
          resolve();
        });
      } else {
        log.warn(`Mock server is already running on port ${config.mock.port}`);
      }
    });
  }

  stop() {
    log.trace(`Stopping mock server on port ${config.mock.port}`);
    return new Promise((resolve) => {
      if (this.app) {
        this.app.server.close(() => {
          log.info(`Mock server stopped on port ${config.mock.port}`);
          resolve();
        });
      } else {
        log.warn(`Mock server is not running on port ${config.mock.port}`);
        resolve();
      }
    });
  }

  addMockInteraction(id, interaction) {
    this.mockInteractions.set(id, interaction);
  }

  addPactInteraction(id, interaction) {
    store.addInteraction(interaction);
    this.pactInteractions.set(id, interaction);
  }

  removeInteraction(id) {
    if (this.mockInteractions.has(id)) {
      this.mockInteractions.delete(id);
    } else if (this.pactInteractions.has(id)) {
      this.pactInteractions.delete(id);
    } else {
      // error
    }

  }

  removeMockInteraction(id) {
    this.mockInteractions.delete(id);
  }

  removePactInteraction(id) {
    this.pactInteractions.delete(id);
  }

  clearMockInteractions() {
    this.mockInteractions.clear();
  }

  clearPactInteractions() {
    this.pactInteractions.clear();
  }

  clearAllInteractions() {
    this.mockInteractions.clear();
    this.pactInteractions.clear();
  }

}

/**
 * registers all routes for interactions
 * @param {Server} server - server object
 * @param {Express} app - express app object
 */
function registerAllRoutes(server, app) {
  app.all('/*', (req, response) => {
    const res = new ExpressResponse(response);
    let interactionExercised = false;
    let interaction = helper.getMatchingInteraction(req, server.pactInteractions);
    if (!interaction) {
      interaction = helper.getMatchingInteraction(req, server.mockInteractions);
    }
    if (interaction) {
      store.updateInteractionExerciseCounter(interaction.id);
      interaction.exercised = true;
      interactionExercised = true;
      if (typeof interaction.willRespondWith === 'function') {
        interaction.willRespondWith(req, res);
      } else {
        res.set(interaction.willRespondWith.headers);
        res.status(interaction.willRespondWith.status);
        if (interaction.willRespondWith.body) {
          res.send(interaction.willRespondWith.body);
        } else {
          res.send();
        }
      }
    }
    if (!interactionExercised) {
      log.warn('Interaction not found');
      log.warn({
        method: req.method,
        path: req.path,
        headers: req.headers,
        query: req.query,
        body: req.body
      });
      res.status(404);
      res.send('Interaction Not Found');
    }
  });
}

function registerPactumRemoteRoutes(server) {
  const app = server.app;
  app.all('/api/pactum/*', (req, res) => {
    switch (req.path) {
      case '/api/pactum/mockInteraction':
        handleRemoteInteractions(req, res, server, 'MOCK');
        break;
      case '/api/pactum/pactInteraction':
        handleRemoteInteractions(req, res, server, 'PACT');
        break;
      // publish pacts
      default:
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.write("404 Not Found\n");
        res.end();
        break;
    }
  });
}

function handleRemoteInteractions(req, response, server, interactionType) {
  const res = new ExpressResponse(response);
  const mock = interactionType === 'MOCK';
  const interactions = (mock ? server.mockInteractions : server.pactInteractions);
  const rawInteractions = [];
  const ids = [];
  try {
    switch (req.method) {
      case 'POST':
        for (let i = 0; i < req.body.length; i++) {
          const rawInteraction = req.body[i];
          const remoteInteraction = new Interaction(rawInteraction, mock);
          interactions.set(remoteInteraction.id, remoteInteraction);
          ids.push(remoteInteraction.id);
          if (!mock) {
            store.addInteraction(remoteInteraction);
          }
        }
        res.status(200);
        res.send(ids);
        break;
      case 'GET':
        if (req.query.id) {
          rawInteractions.push(interactions.get(req.query.id).rawInteraction);
        } else {
          for (let [id, interaction] of interactions) {
            rawInteractions.push(interaction.rawInteraction);
          }
        }
        res.status(200);
        res.send(rawInteractions);
        break;
      case 'DELETE':
        if (req.query.id) {
          interactions.delete(req.query.id);
        } else {
          interactions.clear();
        }
        res.status(200);
        res.send();
        break;
      default:
        res.status(405);
        res.send();
        break;
    }
  } catch (error) {
    log.error(`Error saving remote interaction - ${error}`);
    res.status(400);
    res.send({ error: error.message });
  }

}

function bodyParser(req, res, next) {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    req.body = helper.getJson(body);
    next();
  });
}

class ExpressResponse {
  constructor(res) {
    this.res = res;
  }

  status(code) {
    this.res.statusCode = code;
  }

  set(headers) {
    for (const prop in headers) {
      this.res.setHeader(prop, headers[prop]);
    }
  }

  send(data) {
    if (data) {
      if (typeof data === 'object') {
        this.res.setHeader('Content-Type', 'application/json');
        this.res.end(JSON.stringify(data));
      } else {
        this.res.end(data);
      }
    } else {
      this.res.end();
    }
  }
}

module.exports = Server;
