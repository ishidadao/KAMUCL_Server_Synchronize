import java.lang.reflect.InvocationTargetException;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.HexFormat;

/** ASCII native entry: restore actual Unicode paths only inside the owned JVM. */
public final class BridgeExitLauncher {
    private static Path decodePath(String encoded) throws Exception {
        return Path.of(new String(Base64.getDecoder().decode(encoded), StandardCharsets.UTF_8)).toRealPath();
    }

    private static String encodedPath(Path path) throws Exception {
        return Base64.getEncoder().encodeToString(path.toRealPath().toString().getBytes(StandardCharsets.UTF_8));
    }

    private static Path codeSource(Class<?> type) throws Exception {
        return Path.of(type.getProtectionDomain().getCodeSource().getLocation().toURI()).toRealPath();
    }

    private static String sha256(Path file) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(Files.readAllBytes(file)));
    }

    public static void main(String[] args) throws Throwable {
        if (args.length != 4) throw new IllegalArgumentException("Expected four UTF-8/Base64 fixture paths");
        Path fixtureClasses = decodePath(args[0]), bridge = decodePath(args[1]);
        Path gson = decodePath(args[2]), profile = decodePath(args[3]);
        URL[] locations = { fixtureClasses.toUri().toURL(), bridge.toUri().toURL(), gson.toUri().toURL() };
        // The application loader contains only this launcher. The new loader
        // inherits the platform, never a duplicate fixture or bridge from it.
        URLClassLoader loader = new URLClassLoader(locations, ClassLoader.getPlatformClassLoader());
        Thread.currentThread().setContextClassLoader(loader);
        Class<?> fixture = Class.forName("cn.kamucl.bridge.BridgeExitFixture", false, loader);
        Class<?> bridgeType = Class.forName("cn.kamucl.bridge.BridgeServer", false, loader);
        Class<?> gsonType = Class.forName("com.google.gson.Gson", false, loader);
        boolean distinct = fixture.getClassLoader() == loader && bridgeType.getClassLoader() == loader
                && gsonType.getClassLoader() == loader && loader != BridgeExitLauncher.class.getClassLoader();
        Path actualBridge = codeSource(bridgeType), actualGson = codeSource(gsonType);
        System.out.println("FIXTURE_LOADING_PROOF {\"schemaVersion\":1,\"loaderParentPlatform\":"
                + (loader.getParent() == ClassLoader.getPlatformClassLoader()) + ",\"loaderDistinct\":" + distinct
                + ",\"bridgeCodeSource\":\"" + encodedPath(actualBridge) + "\",\"bridgeSHA256\":\"" + sha256(actualBridge)
                + "\",\"gsonCodeSource\":\"" + encodedPath(actualGson) + "\",\"gsonSHA256\":\"" + sha256(actualGson)
                + "\",\"fixtureCodeSource\":\"" + encodedPath(codeSource(fixture)) + "\",\"profile\":\"" + encodedPath(profile) + "\"}");
        // Do not close the loader, force exit, or change thread daemon status:
        // the original fixture's save and natural JVM exit remain the gate.
        try {
            fixture.getMethod("main", String[].class).invoke(null, (Object) new String[] { profile.toString() });
        } catch (InvocationTargetException error) {
            throw error.getCause();
        }
    }
}
