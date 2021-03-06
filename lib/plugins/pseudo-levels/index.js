var path = require('path'),
    fs = require('fs'),
    naming = require('bem-naming'),
    pseudo = require('enb-bem-pseudo-levels'),
    builder = require('./builder');

/**
 * Возвращает конфигуратор уровня-сетов из примеров БЭМ-блоков с помощью `MagicHelper`.
 * Умеет собирать примеры по папкам-технологиям (simple-уровням).
 *
 * @param {MagicHelper} helper
 * @returns {{configure: Function}}
 */
module.exports = function (helper) {
    return {
        /**
         * Настраивает сборку псевдоуровеня-сета. В процессе сборки вначале будут созданы симлинки на все нужные файлы
         * и директории, а за тем нужные файлы будут скопированы из оригинальных исходных файлов.
         *
         * @param {Object}   options
         * @param {String}   options.destPath       Путь до нового уровня-сета относительный корня.
         * @param {Array}    options.levels         Уровни в которых следует искать примеры.
         * @param {String[]} [options.techSuffixes] Суффиксы папок-технологий с примерами.
         * @param {String[]} [options.fileSuffixes] Суффиксы файлов внутри папок-технологий с примерами.
         */
        configure: function (options) {
            var _this = this;

            helper.prebuild(function (magic) {
                return _this._buildPseudoLevels(magic, options)
                    .then(function (filenames) {
                        _this._registerTargets(magic, filenames, options);
                    });
            });

            this._copySymlinks(options);
        },

        _buildPseudoLevels: function (magic, options) {
            var root = helper.getRootPath(),
                dstpath = path.resolve(root, options.destPath),
                resolve = builder({
                    techSuffixes: options.techSuffixes,
                    fileSuffixes: options.fileSuffixes
                }),
                // Получаем абсолютные пути таргетов, которые нужно построить
                dstargs = magic.getRequiredTargets().map(function (arg) {
                    // Добавляем расширение `.symlink` если пользователь ожидает таргет
                    var target = (arg.split(path.sep).length > 3) ? arg + '.symlink' : arg;

                    return path.resolve(root, target);
                });

            // Строим псевдоуровень
            return pseudo(options.levels)
                .addBuilder(dstpath, resolve)
                .build(dstargs);
        },

        _copySymlinks: function (options) {
            helper.configure(function (config, nodes) {
                var setNodes = nodes.filter(function (node) {
                    return node.split(path.sep)[0] === options.destPath;
                });

                config.nodes(setNodes, function (nodeConfig) {
                    var node = path.basename(nodeConfig.getNodePath());

                    options.fileSuffixes.forEach(function (suffix) {
                        var target = node + '.' + suffix,
                            symlinkTarget = target + '.symlink',
                            symlinkFilename = nodeConfig.resolvePath(symlinkTarget);

                        // Проверяем нужно ли копировать файл по симлинке
                        if (fs.existsSync(symlinkFilename)) {
                            nodeConfig.addTechs([
                                [require('enb/techs/file-provider'), { target: symlinkTarget }],
                                [require('enb/techs/file-copy'), {
                                    source: symlinkTarget,
                                    target: target
                                }]
                            ]);
                            nodeConfig.addTarget(target);
                        }
                    });
                });
            });
        },

        _registerTargets: function (magic, filenames, options) {
            var root = helper.getRootPath(),
                channel = helper.getEventChannel(),
                nodes = {};

            // Регистрируем новые ноды и таргеты в рамках построенного псевдоуровня
            filenames.forEach(function (filename) {
                var node = path.dirname(path.relative(root, filename)),
                    basename = path.basename(node);

                if (node.split(path.sep).length === 3 && magic.isRequiredNode(node)) {
                    nodes[node] = true;

                    if (options.fileSuffixes.length) {
                        // Регистрируем созданные файлы как таргеты
                        options.fileSuffixes.forEach(function (suffix) {
                            magic.registerTarget(path.join(node, basename + '.' + suffix));
                        });
                    } else {
                        magic.registerNode(node);
                    }
                }
            });

            // Сообщаем о созданных примерах
            var examples = Object.keys(nodes).map(function (node) {
                var basename = path.basename(node);

                return {
                    name: basename,
                    path: node,
                    notation: naming.parse(basename)
                };
            });

            channel.emit('examples', options.destPath, examples);
        }
    };
};
