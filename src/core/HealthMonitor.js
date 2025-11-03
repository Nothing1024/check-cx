const cron = require('node-cron');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const logger = require('../utils/logger');
const { StatusStore } = require('./StatusStore');
const { ServiceChecker, resolvePath } = require('./ServiceChecker');

/**
 * Calculate uptime percentage from recent checks
 * @param {Array} recentChecks
 * @returns {number}
 */
function calculateUptime(recentChecks) {
  if (!Array.isArray(recentChecks) || recentChecks.length === 0) {
    return 0;
  }

  const successCount = recentChecks.filter((check) => check.status === 'ok').length;
  return Math.round((successCount / recentChecks.length) * 100 * 10) / 10;
}

class HealthMonitor {
  constructor(options = {}) {
    this.checker = options.checker instanceof ServiceChecker ? options.checker : null;
    this.store = options.store instanceof StatusStore ? options.store : null;
    this.logger = options.logger || logger;
    this.isChecking = false;
    this.serviceTasks = new Map();
    this.claudeConfigInitialized = false;
  }

  bindChecker(checker) {
    this.checker = checker;
  }

  bindStore(store) {
    this.store = store;
  }

  /**
   * Initialize local Claude configuration with template defaults, project entries,
   * and pre-approved API key suffixes discovered in service configurations.
   */
  async initializeClaudeConfig() {
    if (this.claudeConfigInitialized) {
      return;
    }

    try {
      this.#assertReady();

      const templatePath = path.join(__dirname, '..', '..', 'template', '.claude.json');
      const claudeConfigPath = path.join(os.homedir(), '.claude.json');

      let claudeConfig;
      try {
        const templateContent = await fsp.readFile(templatePath, 'utf8');
        claudeConfig = JSON.parse(templateContent);
        this.logger.log('info', 'init-claude', 'Loaded template from template/.claude.json');
      } catch (error) {
        throw new Error(`Failed to read template/.claude.json: ${error.message}`);
      }

      const config = await this.store.loadConfig();
      const services = Array.isArray(config.services) ? config.services : [];

      if (!claudeConfig.projects || typeof claudeConfig.projects !== 'object') {
        claudeConfig.projects = {};
      }

      const PROJECT_ROOT = process.env.PROJECT_ROOT || process.cwd();
      const effectiveResolvePath =
        typeof resolvePath === 'function'
          ? resolvePath
          : (inputPath) => (path.isAbsolute(inputPath) ? inputPath : path.join(PROJECT_ROOT, inputPath));

      for (const service of services) {
        if (!service || service.enabled !== true) {
          continue;
        }

        // Only process Claude services
        if (service.type !== 'claude') {
          continue;
        }

        const identifier = service.name || service.id || 'unknown';
        if (!service.cwd) {
          throw new Error(`Claude service "${identifier}" is enabled but missing required "cwd" field`);
        }

        const absolutePath = effectiveResolvePath(service.cwd);
        if (claudeConfig.projects[absolutePath]) {
          this.logger.log('info', 'init-claude', `Project already exists: ${absolutePath}, skipping`);
          continue;
        }

        claudeConfig.projects[absolutePath] = {
          allowedTools: [],
          history: [],
          mcpContextUris: [],
          mcpServers: {},
          enabledMcpjsonServers: [],
          disabledMcpjsonServers: [],
          hasTrustDialogAccepted: true,
          ignorePatterns: [],
          projectOnboardingSeenCount: 1,
          hasClaudeMdExternalIncludesApproved: false,
          hasClaudeMdExternalIncludesWarningShown: false,
          exampleFiles: []
        };

        this.logger.log('info', 'init-claude', `Added project: ${absolutePath}`);
      }

      const apiKeySuffixes = new Set();
      for (const service of services) {
        if (!service) {
          continue;
        }

        // Only process Claude services for API key extraction
        if (service.type !== 'claude') {
          continue;
        }

        const identifier = service.name || service.id || service.cwd || 'unknown';
        if (!service.cwd) {
          this.logger.log(
            'info',
            'init-claude',
            `Claude service "${identifier}" missing "cwd"; skipping API key preload`
          );
          continue;
        }

        const resolvedCwd = effectiveResolvePath(service.cwd);
        const settingsPath = path.join(resolvedCwd, '.claude', 'settings.json');

        let settingsContent;
        try {
          settingsContent = await fsp.readFile(settingsPath, 'utf8');
        } catch (error) {
          if (error.code === 'ENOENT') {
            this.logger.log(
              'warn',
              'init-claude',
              `Claude settings not found for ${identifier}; skipping`
            );
            continue;
          }
          this.logger.log(
            'warn',
            'init-claude',
            `Failed to read Claude settings for ${identifier}`,
            error
          );
          continue;
        }

        let settings;
        try {
          settings = JSON.parse(settingsContent);
        } catch (error) {
          this.logger.log(
            'warn',
            'init-claude',
            `Invalid Claude settings JSON for ${identifier}`,
            error
          );
          continue;
        }

        const apiKey = settings?.env?.ANTHROPIC_API_KEY;
        if (!apiKey || typeof apiKey !== 'string') {
          this.logger.log(
            'info',
            'init-claude',
            `No Anthropic API key defined for ${identifier}; skipping`
          );
          continue;
        }

        if (apiKey.length < 20) {
          this.logger.log(
            'warn',
            'init-claude',
            `API key for ${identifier} too short to extract suffix; skipping`
          );
          continue;
        }

        const suffix = apiKey.slice(-20);
        if (!apiKeySuffixes.has(suffix)) {
          this.logger.log('info', 'init-claude', `Found API key for ${identifier}: ...${suffix}`);
        }
        apiKeySuffixes.add(suffix);
      }

      if (!claudeConfig.customApiKeyResponses || typeof claudeConfig.customApiKeyResponses !== 'object') {
        claudeConfig.customApiKeyResponses = {};
      }

      if (!Array.isArray(claudeConfig.customApiKeyResponses.approved)) {
        claudeConfig.customApiKeyResponses.approved = [];
      }

      const approved = claudeConfig.customApiKeyResponses.approved;
      let addedCount = 0;
      for (const suffix of apiKeySuffixes) {
        if (!approved.includes(suffix)) {
          approved.push(suffix);
          addedCount += 1;
        }
      }

      if (addedCount > 0) {
        this.logger.log(
          'info',
          'init-claude',
          `Added ${addedCount} API key approval(s) to configuration`
        );
      } else {
        this.logger.log('info', 'init-claude', 'All API keys already approved');
      }

      await fsp.writeFile(claudeConfigPath, JSON.stringify(claudeConfig, null, 2), 'utf8');
      this.logger.log('info', 'init-claude', 'Claude configuration initialized successfully');

      this.claudeConfigInitialized = true;
    } catch (error) {
      this.claudeConfigInitialized = false;
      this.logger.log('error', 'init-claude', 'Failed to initialize Claude configuration', error);
      throw error;
    }
  }

  async start() {
    this.#assertReady();
    if (this.serviceTasks.size > 0) {
      return;
    }

    await this.initializeClaudeConfig();

    const services = await this.#loadEnabledServices();

    for (const service of services) {
      const serviceId = service.id || service.name;
      if (!serviceId) continue;

      const intervalMinutes = service.checkInterval || 5;
      const cronExpression = `*/${intervalMinutes} * * * *`;

      const task = cron.schedule(cronExpression, () => {
        this.runCheckForService(service).catch((error) => {
          this.logger.log('error', 'monitor', `Failed to check service ${serviceId}`, error);
        });
      });

      this.serviceTasks.set(serviceId, task);
      this.logger.log('info', 'monitor', `Scheduled service ${serviceId} with interval ${intervalMinutes} minutes`);

      this.runCheckForService(service).catch((error) => {
        this.logger.log('error', 'monitor', `Failed initial check for service ${serviceId}`, error);
      });
    }

    this.generatePublicStatus().catch((error) => {
      this.logger.log('warn', 'monitor', 'Failed to generate initial public status', error);
    });
  }

  stop() {
    for (const [serviceId, task] of this.serviceTasks.entries()) {
      task.stop();
      this.logger.log('info', 'monitor', `Stopped task for service ${serviceId}`);
    }
    this.serviceTasks.clear();
  }

  async runCheckForService(service) {
    this.#assertReady();
    const serviceId = service.id || service.name;
    if (!serviceId) return;

    try {
      const result = await this.checker.check(service);
      await this.store.recordCheckResult(serviceId, result);
    } catch (error) {
      const fallback = {
        name: service.name || serviceId,
        stdout: '',
        stderr: '',
        checkedAt: new Date().toISOString(),
        status: 'error',
        message: error.message,
        responseTime: 0,
        expectedAnswer: service.expectedAnswer ?? null
      };
      this.logger.log('error', 'monitor', `Failed to check service ${serviceId}`, { error, result: fallback });
      await this.store.recordCheckResult(serviceId, fallback);
    }

    await this.generatePublicStatus();
  }

  async runChecks() {
    this.#assertReady();
    const services = await this.#loadEnabledServices();
    if (services.length === 0) {
      this.logger.log('warn', 'monitor', 'No enabled services found in configuration');
      await this.generatePublicStatus();
      return;
    }

    for (const service of services) {
      await this.runCheckForService(service);
    }
  }

  async generatePublicStatus() {
    try {
      this.#assertReady();
      const config = await this.store.loadConfig();
      const servicesConfig = Array.isArray(config.services) ? config.services : [];
      const summaries = await this.store.getAllServicesSummary();

      const configMap = new Map();
      for (const service of servicesConfig) {
        const serviceId = service?.id || service?.name;
        if (serviceId) {
          configMap.set(serviceId, service);
        }
      }

      const publicServices = [];
      for (const summary of summaries) {
        const serviceConfig = configMap.get(summary.id);
        if (!serviceConfig) {
          continue;
        }

        publicServices.push({
          displayName: serviceConfig.displayName || summary.name,
          status: summary.currentStatus,
          lastCheck: summary.lastCheck,
          uptime: calculateUptime(summary.recentChecks)
        });
      }

      const overall = {
        healthy: publicServices.filter((s) => s.status === 'ok').length,
        unhealthy: publicServices.filter(
          (s) => s.status !== 'ok' && s.status !== 'unknown'
        ).length,
        unknown: publicServices.filter((s) => s.status === 'unknown').length,
        total: publicServices.length
      };

      const publicData = {
        services: publicServices,
        overall,
        timestamp: new Date().toISOString()
      };

      const outputPath = path.join(__dirname, '..', '..', 'frontend', 'dist', 'status.json');
      const outputDir = path.dirname(outputPath);
      await fsp.mkdir(outputDir, { recursive: true });
      await fsp.writeFile(outputPath, JSON.stringify(publicData, null, 2), 'utf8');

      this.logger.log('info', 'monitor', `Generated public status: ${publicServices.length} services`);
    } catch (error) {
      this.logger.log('warn', 'monitor', 'Failed to generate public status', error);
    }
  }

  async #loadEnabledServices() {
    const config = await this.store.loadConfig();
    const services = Array.isArray(config.services) ? config.services : [];
    return services.filter((service) => service && service.enabled);
  }

  #assertReady() {
    if (!this.checker) {
      throw new Error('HealthMonitor checker is not bound');
    }
    if (!this.store) {
      throw new Error('HealthMonitor store is not bound');
    }
  }
}

module.exports = { HealthMonitor };
