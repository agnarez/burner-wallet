/*
 * vanity-miner.c — CREATE2 vanity salt miner for the $AGNA deployment.
 *
 * Finds a 32-byte salt such that the CREATE2 address
 *   keccak256(0xff || deployer || salt || keccak256(initCode))[12:]
 * starts with a given hex prefix (default: a69000, 6 hex chars).
 *
 * Why C and not ethers.js: mining a 6-hex-char prefix needs ~16.7M
 * keccak hashes on average. ethers.js keccak256 manages ~26k hashes/s
 * on this VM (~11 minutes); this native miner does millions per second
 * per core, so the same search finishes in seconds.
 *
 * The Keccak-f[1600] permutation below is the standard reference
 * construction (rate 136 bytes, suffix 0x01, pad10*1) — Keccak-256, NOT
 * NIST SHA3. It is verified against the known test vectors
 * (keccak256("") and keccak256("abc")) by `make test` / --self-test,
 * and every mined salt is re-verified against ethers.js
 * getCreate2Address and on-chain predict() before any deployment.
 *
 * Usage:
 *   gcc -O3 -march=native -pthread -o vanity-miner vanity-miner.c
 *   ./vanity-miner --deployer 0x... --init-code-hash 0x... [--prefix a69000] [--threads 4] [--start 0]
 *
 * Output on success (stdout, one line, machine-readable):
 *   SALT=0x... ADDRESS=0x... TRIES=12345678 ELAPSED_S=3.21 RATE=3847291
 * Progress goes to stderr. Exit 0 on success.
 */
#define _POSIX_C_SOURCE 200809L
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <stdbool.h>
#include <stdatomic.h>
#include <pthread.h>
#include <time.h>
#include <getopt.h>

/* ------------------------------------------------------------------ */
/* Keccak-f[1600]                                                      */
/* ------------------------------------------------------------------ */

static inline uint64_t rotl64(uint64_t x, int n) {
    return (x << n) | (x >> (64 - n));
}

static const uint64_t RC[24] = {
    0x0000000000000001ULL, 0x0000000000008082ULL, 0x800000000000808aULL,
    0x8000000080008000ULL, 0x000000000000808bULL, 0x0000000080000001ULL,
    0x8000000080008081ULL, 0x8000000000008009ULL, 0x000000000000008aULL,
    0x0000000000000088ULL, 0x0000000080008009ULL, 0x000000008000000aULL,
    0x000000008000808bULL, 0x800000000000008bULL, 0x8000000000008089ULL,
    0x8000000000008003ULL, 0x8000000000008002ULL, 0x8000000000000080ULL,
    0x000000000000800aULL, 0x800000008000000aULL, 0x8000000080008081ULL,
    0x8000000000008080ULL, 0x0000000080000001ULL, 0x8000000080008008ULL
};

/* Rotation offsets for the 24 rho steps, in piloting order. */
static const int ROTC[24] = {
    1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14,
    27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44
};

/* Lane-piloting order for rho+pi. */
static const int PILN[24] = {
    10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4,
    15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1
};

static void keccakf(uint64_t st[25]) {
    for (int round = 0; round < 24; round++) {
        uint64_t bc[5];
        /* Theta */
        for (int i = 0; i < 5; i++)
            bc[i] = st[i] ^ st[i + 5] ^ st[i + 10] ^ st[i + 15] ^ st[i + 20];
        for (int i = 0; i < 5; i++) {
            uint64_t t = bc[(i + 4) % 5] ^ rotl64(bc[(i + 1) % 5], 1);
            for (int j = 0; j < 25; j += 5)
                st[j + i] ^= t;
        }
        /* Rho + Pi */
        uint64_t t = st[1];
        for (int i = 0; i < 24; i++) {
            int j = PILN[i];
            bc[0] = st[j];
            st[j] = rotl64(t, ROTC[i]);
            t = bc[0];
        }
        /* Chi */
        for (int j = 0; j < 25; j += 5) {
            for (int i = 0; i < 5; i++)
                bc[i] = st[j + i];
            for (int i = 0; i < 5; i++)
                st[j + i] ^= (~bc[(i + 1) % 5]) & bc[(i + 2) % 5];
        }
        /* Iota */
        st[0] ^= RC[round];
    }
}

/* Keccak-256 (rate 136, suffix 0x01). out must hold 32 bytes. */
static void keccak256(const uint8_t *in, size_t inlen, uint8_t out[32]) {
    uint64_t st[25];
    memset(st, 0, sizeof(st));
    /* Absorb full blocks. */
    while (inlen >= 136) {
        for (int i = 0; i < 17; i++) {
            uint64_t lane = 0;
            for (int b = 0; b < 8; b++)
                lane |= (uint64_t)in[i * 8 + b] << (8 * b);
            st[i] ^= lane;
        }
        keccakf(st);
        in += 136;
        inlen -= 136;
    }
    /* Final block with pad10*1. */
    uint8_t temp[136];
    memset(temp, 0, sizeof(temp));
    memcpy(temp, in, inlen);
    temp[inlen] = 0x01;
    temp[135] |= 0x80;
    for (int i = 0; i < 17; i++) {
        uint64_t lane = 0;
        for (int b = 0; b < 8; b++)
            lane |= (uint64_t)temp[i * 8 + b] << (8 * b);
        st[i] ^= lane;
    }
    keccakf(st);
    /* Squeeze 32 bytes (little-endian lanes). */
    for (int i = 0; i < 4; i++) {
        uint64_t lane = st[i];
        for (int b = 0; b < 8; b++)
            out[i * 8 + b] = (uint8_t)(lane >> (8 * b));
    }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

static int hexval(int c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

/* Parse a 0x-prefixed (or bare) hex string into bytes. Returns length or -1. */
static int parse_hex(const char *s, uint8_t *out, size_t maxlen) {
    if (s[0] == '0' && (s[1] == 'x' || s[1] == 'X')) s += 2;
    size_t len = strlen(s);
    if (len % 2 != 0 || len / 2 > maxlen) return -1;
    for (size_t i = 0; i < len / 2; i++) {
        int hi = hexval((unsigned char)s[2 * i]);
        int lo = hexval((unsigned char)s[2 * i + 1]);
        if (hi < 0 || lo < 0) return -1;
        out[i] = (uint8_t)((hi << 4) | lo);
    }
    return (int)(len / 2);
}

static void fprint_hex(FILE *f, const uint8_t *p, size_t len) {
    for (size_t i = 0; i < len; i++) fprintf(f, "%02x", p[i]);
}

static void print_hex(const uint8_t *p, size_t len) {
    fprint_hex(stdout, p, len);
}

static bool self_test(void) {
    uint8_t out[32];
    uint8_t expect_empty[32] = {
        0xc5, 0xd2, 0x46, 0x01, 0x86, 0xf7, 0x23, 0x3c, 0x92, 0x7e, 0x7d, 0xb2, 0xdc, 0xc7, 0x03, 0xc0,
        0xe5, 0x00, 0xb6, 0x53, 0xca, 0x82, 0x27, 0x3b, 0x7b, 0xfa, 0xd8, 0x04, 0x5d, 0x85, 0xa4, 0x70
    };
    uint8_t expect_abc[32] = {
        0x4e, 0x03, 0x65, 0x7a, 0xea, 0x45, 0xa9, 0x4f, 0xc7, 0xd4, 0x7b, 0xa8, 0x26, 0xc8, 0xd6, 0x67,
        0xc0, 0xd1, 0xe6, 0xe3, 0x3a, 0x64, 0xa0, 0x36, 0xec, 0x44, 0xf5, 0x8f, 0xa1, 0x2d, 0x6c, 0x45
    };
    keccak256((const uint8_t *)"", 0, out);
    if (memcmp(out, expect_empty, 32) != 0) {
        fprintf(stderr, "self-test FAILED: keccak256(\"\") mismatch\n");
        return false;
    }
    keccak256((const uint8_t *)"abc", 3, out);
    if (memcmp(out, expect_abc, 32) != 0) {
        fprintf(stderr, "self-test FAILED: keccak256(\"abc\") mismatch\n");
        return false;
    }
    fprintf(stderr, "self-test PASSED: keccak256 vectors match\n");
    return true;
}

/* ------------------------------------------------------------------ */
/* Mining                                                              */
/* ------------------------------------------------------------------ */

static uint8_t g_deployer[20];
static uint8_t g_init_code_hash[32];
static uint8_t g_prefix[20];
static size_t g_prefix_len = 3; /* bytes: "a69000" = 3 bytes */
static _Atomic bool g_found = false;
static _Atomic uint64_t g_tries = 0;
static uint64_t g_found_salt = 0;
static uint8_t g_found_addr[20];
static _Atomic int g_done_threads = 0;

static double now_s(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec + ts.tv_nsec / 1e9;
}

/* Check whether the CREATE2 address for `salt` starts with the prefix. */
static bool try_salt(uint64_t salt, uint8_t addr_out[20]) {
    uint8_t buf[85];
    uint8_t hash[32];
    buf[0] = 0xff;
    memcpy(buf + 1, g_deployer, 20);
    /* The 32-byte salt is big-endian: 24 zero bytes, then the 8-byte
     * big-endian counter. (Putting the counter first would hash the
     * salt V<<192 instead of V — a real bug caught by the ethers
     * cross-check.) */
    memset(buf + 21, 0, 24);
    for (int i = 0; i < 8; i++)
        buf[45 + i] = (uint8_t)(salt >> (8 * (7 - i)));
    memcpy(buf + 53, g_init_code_hash, 32);
    keccak256(buf, 85, hash);
    memcpy(addr_out, hash + 12, 20);
    return memcmp(addr_out, g_prefix, g_prefix_len) == 0;
}

static void *miner_thread(void *arg) {
    long tid = (long)arg;
    extern int g_nthreads;
    uint64_t salt = (uint64_t)tid;
    uint8_t addr[20];
    uint64_t local = 0;
    while (!atomic_load(&g_found)) {
        if (try_salt(salt, addr)) {
            bool expected = false;
            if (atomic_compare_exchange_strong(&g_found, &expected, true)) {
                g_found_salt = salt;
                memcpy(g_found_addr, addr, 20);
            }
            break;
        }
        salt += (uint64_t)g_nthreads;
        if (++local % 1000000 == 0) {
            atomic_fetch_add(&g_tries, 1000000);
            local = 0;
        }
    }
    atomic_fetch_add(&g_tries, local);
    atomic_fetch_add(&g_done_threads, 1);
    return NULL;
}

int g_nthreads = 4;

static void usage(const char *prog) {
    fprintf(stderr,
        "Usage: %s --deployer 0x... --init-code-hash 0x... [--prefix a69000] [--threads N] [--start N] [--self-test]\n"
        "  --deployer        CREATE2 deployer address (20 bytes hex)\n"
        "  --init-code-hash  keccak256 of the init code to deploy (32 bytes hex)\n"
        "  --prefix          hex prefix the deployed address must start with (default a69000)\n"
        "  --threads         worker threads (default 4)\n"
        "  --start           first salt to try (default 0)\n"
        "  --self-test       verify the keccak implementation and exit\n",
        prog);
}

int main(int argc, char **argv) {
    const char *deployer_s = NULL;
    const char *hash_s = NULL;
    const char *prefix_s = "a69000";
    uint64_t start = 0;

    static struct option long_opts[] = {
        {"deployer", required_argument, 0, 'd'},
        {"init-code-hash", required_argument, 0, 'h'},
        {"prefix", required_argument, 0, 'p'},
        {"threads", required_argument, 0, 't'},
        {"start", required_argument, 0, 's'},
        {"self-test", no_argument, 0, 'T'},
        {0, 0, 0, 0}
    };
    int opt;
    while ((opt = getopt_long(argc, argv, "d:h:p:t:s:T", long_opts, NULL)) != -1) {
        switch (opt) {
        case 'd': deployer_s = optarg; break;
        case 'h': hash_s = optarg; break;
        case 'p': prefix_s = optarg; break;
        case 't': g_nthreads = atoi(optarg); if (g_nthreads < 1) g_nthreads = 1; if (g_nthreads > 64) g_nthreads = 64; break;
        case 's': start = strtoull(optarg, NULL, 0); break;
        case 'T': return self_test() ? 0 : 1;
        default: usage(argv[0]); return 1;
        }
    }
    if (!deployer_s || !hash_s) { usage(argv[0]); return 1; }
    if (parse_hex(deployer_s, g_deployer, 20) != 20) {
        fprintf(stderr, "bad --deployer (want 20 bytes hex)\n");
        return 1;
    }
    if (parse_hex(hash_s, g_init_code_hash, 32) != 32) {
        fprintf(stderr, "bad --init-code-hash (want 32 bytes hex)\n");
        return 1;
    }
    if (parse_hex(prefix_s, g_prefix, 20) < 0 || strlen(prefix_s) % 2 != 0) {
        fprintf(stderr, "bad --prefix (want even-length hex)\n");
        return 1;
    }
    g_prefix_len = strlen(prefix_s) / 2;

    /* The salt is a uint256: threads start at start+tid and stride by
     * nthreads. Salts above 2^64 are never needed for a 6-char prefix
     * (expected tries 16.7M), so a 64-bit counter is plenty. */
    if (!self_test()) return 1;

    fprintf(stderr, "mining prefix 0x%s for deployer 0x", prefix_s);
    fprint_hex(stderr, g_deployer, 20);
    fprintf(stderr, " (%d threads, start %llu)\n", g_nthreads, (unsigned long long)start);

    pthread_t *threads = malloc(sizeof(pthread_t) * (size_t)g_nthreads);
    double t0 = now_s();
    /* Thread i starts at salt start+i and strides by g_nthreads, so
     * thread i covers start+i, start+i+N, start+i+2N, ... The start
     * value is passed through the void* argument (LP64: a long fits). */
    for (long i = 0; i < g_nthreads; i++)
        pthread_create(&threads[i], NULL, miner_thread, (void *)(start + (uint64_t)i));
    for (int i = 0; i < g_nthreads; i++) pthread_join(threads[i], NULL);
    double elapsed = now_s() - t0;
    uint64_t tries = atomic_load(&g_tries);

    /* Recompute the address for the winning salt (defense in depth: the
     * thread that found it already stored the address, but verify). */
    uint8_t verify_addr[20];
    if (!try_salt(g_found_salt, verify_addr) || memcmp(verify_addr, g_found_addr, 20) != 0) {
        fprintf(stderr, "internal error: winning salt does not verify\n");
        return 1;
    }

    printf("SALT=0x%064llx ADDRESS=0x", (unsigned long long)g_found_salt);
    print_hex(g_found_addr, 20);
    printf(" TRIES=%llu ELAPSED_S=%.2f RATE=%.0f\n",
           (unsigned long long)tries, elapsed,
           elapsed > 0 ? (double)tries / elapsed : 0.0);
    return 0;
}
