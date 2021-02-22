@echo off
set VER=1.0.13

sed -i -E "s/\"version\": \".+?\"/\"version\": \"%VER%\"/; s/\"name\": \".+?\"/\"name\": \"advanced-night-mode-%VER%\"/" package.json
sed -i -E "s/version>.+?</version>%VER%</; s/download\/.+?\/advanced-night-mode-.+?\.xpi/download\/%VER%\/advanced-night-mode-%VER%\.xpi/" update.xml

set XPI=advanced-night-mode-%VER%.xpi
if exist %XPI% del %XPI%
if exist bootstrap.js del bootstrap.js
if exist install.rdf del install.rdf
call jpm xpi
unzip %XPI% bootstrap.js install.rdf
