var path = require('path'),
    fs = require('fs'),
    crypto = require('crypto'),
    vm = require('vm'),
    naming = require('bem-naming'),
    vow = require('vow'),
    vfs = require('enb/lib/fs/async-fs'),
    scanner = require('enb-bem-pseudo-levels/lib/level-scanner'),
    BEMJSON_CODE_REGEX = /`{3,}bemjson\n([^`]*)\n`{3,}/gi;

/**
 * Возвращает конфигуратор уровня-сетов из примеров БЭМ-блоков с помощью `MagicHelper`.
 * Умеет собирать примеры по md-файлам.
 *
 * @param {MagicHelper} helper
 * @returns {{configure: Function}}
 */
module.exports = function (helper) {
    return {
        /**
         * Настраивает сборку примеров по md-файлам, обрабатывая полученный `bemjson` с помощью `processInlineBemjson`
         * функции. На файловую систему пример запишется с именем равным хэш-сумме от исходного кода примера.
         *
         * Инлайновый пример в md-файле может выглядеть следующим образом:
         *
         * ```bemjson
         * ({
         *     block: 'button',
         *     text: 'Click me!'
         * })
         * ```
         *
         * @param {Object}   options
         * @param {String}   options.destPath               Путь до нового уровня-сета относительный корня.
         * @param {Array}    options.levels                 Уровни в которых следует искать примеры.
         * @param {Function} [options.processInlineBemjson] Функция обработки инлайнового bemjson.
         */
        configure: function (options) {
            this._buildTargets(options);
            this._provideTargets(options);
        },

        _buildTargets: function (options) {
            var channel = helper.getEventChannel(),
                root = helper.getRootPath();

            helper.prebuild(function (magic, logger) {
                return getMdFiles(options.levels)
                    .then(function (filenames) {
                        return getExamplesFromMdFiles(root, options.destPath, filenames);
                    })
                    .then(function (examples) {
                        // Отсеиваем примеры, которые не нужно собирать
                        examples = examples.filter(function (example) {
                            return magic.isRequiredNode(example.path);
                        });

                        return vow.all(examples.map(function (example) {
                            var dirname = path.join(root, example.path),
                                target = path.join(example.path, example.name + '.bemjson.js'),
                                bemjsonFilename = path.join(root, target),
                                bemjson = buildBemjson(example, bemjsonFilename, options.processInlineBemjson, logger);

                            if (!bemjson) {
                                return;
                            }

                            // Записываем bemjson на файловую систему
                            return vfs.makeDir(dirname)
                                .then(function () {
                                    return vfs.write(bemjsonFilename, bemjson, 'utf-8');
                                })
                                .then(function () {
                                    magic.registerTarget(target);

                                    return example;
                                });
                        }));
                    })
                    .then(function (examples) {
                        channel.emit('inline-examples', options.destPath, examples.filter(function (example) {
                            return example;
                        }));
                    });
            });
        },

        _provideTargets: function (options) {
            helper.configure(function (config, nodes) {
                var setNodes = nodes.filter(function (node) {
                    return node.split(path.sep)[0] === options.destPath;
                });

                // Провайдим полученные `bemjson.js` файлы
                config.nodes(setNodes, function (nodeConfig) {
                    var node = path.basename(nodeConfig.getNodePath()),
                        symlinkTarget = node + '.bemjson.js.symlink',
                        symlinkFilename = nodeConfig.resolvePath(symlinkTarget);

                    // Проверяем инлайновый ли это пример
                    if (!fs.existsSync(symlinkFilename)) {
                        nodeConfig.addTech([require('enb/techs/file-provider'), { target: '?.bemjson.js' }]);
                        nodeConfig.addTarget('?.bemjson.js');
                    }
                });
            });
        }
    };
};

function buildBemjson(example, bemjsonFilename, callback, logger) {
    var meta = {
            filename: bemjsonFilename,
            notation: example.notation
        },
        bemjson;

    try {
        bemjson = vm.runInNewContext('(' + example.source + ')', {});
    } catch (err) {
        logger.logWarningAction('inline-bemjson', example.sourcePath, err.name + ': ' + err.message);

        return;
    }

    return '(' + JSON.stringify(callback(bemjson, meta)) + ')';
}

function getExamplesFromMdFiles(root, dstpath, filenames) {
    return vow.all(filenames.map(function (filename) {
            return getExamplesFromMdFile(root, dstpath, filename);
        }))
        .then(function (list) {
            return Array.prototype.concat.apply([], list);
        });
}

function getMdFiles(levels) {
    return scanner.scan(levels)
        .then(function (files) {
            var filenames = [];

            files.forEach(function (file) {
                var ext = path.extname(file.fullname);

                if (ext === '.md') {
                    filenames.push(file.fullname);
                }
            });

            return filenames;
        });
}

function getExamplesFromMdFile(root, dstpath, filename) {
    return vfs.read(filename, 'utf-8')
        .then(function (source) {
            var basename = path.basename(filename),
                examples = getExamplesFromSource(source),
                notation = naming.parse(basename.split('.')[0]),
                scope = path.join(dstpath, notation.block);

            return examples.map(function (example) {
                example.sourcePath = path.relative(root, filename);
                example.path = path.join(scope, example.name);
                example.notation = notation;

                return example;
            });
        });
}

function getExamplesFromSource(source) {
    var matched = source.match(BEMJSON_CODE_REGEX);

    return matched ? matched.map(function (str) {
        var code = str.split('\n').slice(1);

        code.pop();
        code = code.join('\n');

        var shasum = crypto.createHash('sha1'); shasum.update(code);
        var base64 = fixBase64(shasum.digest('base64'));

        return {
            name: base64,
            source: code
        };
    }) : [];
}

function fixBase64(base64) {
    return base64
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '')
        .replace(/^[+-]+/g, '');
}
